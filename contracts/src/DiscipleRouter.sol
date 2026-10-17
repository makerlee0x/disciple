// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {LockedLP} from "./LockedLP.sol";
import {DiscipleHook} from "./DiscipleHook.sol";
import {Constants} from "./libraries/Constants.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ILaunchpadCurveOf {
    function curveOf(address token) external view returns (address);
}

interface IUsdgCurve {
    struct BuyQuoteLite {
        uint256 tokensOut;
        uint256 fee;
        uint256 snipeFee;
        uint256 quoteToCurve;
        uint256 priceAfterX18;
        uint256 impactBps;
        uint256 mcapAfterUsd;
        bool graduates;
        uint256 refund;
    }

    function quote() external view returns (address);
    function graduated() external view returns (bool);
    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline, address recipient) external returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, uint256 deadline, address recipient) external returns (uint256);
    function routerBuy(address trader, uint256 quoteIn, uint256 minTokensOut, uint256 deadline, uint256 maxImpactBps)
        external
        returns (uint256);
    function routerSell(
        address trader,
        uint256 tokensIn,
        uint256 minQuoteOut,
        uint256 deadline,
        address recipient,
        uint256 maxImpactBps
    ) external returns (uint256);
}

/// @title Thin post-graduation router for DISCIPLE v4 pools (exact-in buy/sell)
/// @notice Pre-grad trades go to the token's BondingCurve directly; post-grad trades go here.
///         Users approve this router once per asset (or use the *WithPermit variants) — no custody.
///         For quotes use the official Uniswap V4Quoter (quoteExactInputSingle with the pool key from
///         `poolKeyOf(token)`); the DiscipleHook 1% fee is applied inside the simulated swap.
contract DiscipleRouter is IUnlockCallback {
    using CurrencySettler for Currency;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    LockedLP public immutable lockedLP;
    address public immutable hook;

    /// @notice Hard cap on the price move of a single router swap, in bps of the pre-swap price
    ///         (same |Δprice|/price metric as Trade.impactBps / quoteExactIn). Owner-settable within
    ///         [MIN_MAX_IMPACT_BPS, MAX_MAX_IMPACT_BPS]. Router-only: direct PoolManager swaps are unaffected.
    uint256 public maxImpactBps = 5000;
    uint256 public constant MIN_MAX_IMPACT_BPS = 100; // 1%
    uint256 public constant MAX_MAX_IMPACT_BPS = 100_000; // 10x price move (buys measure Δp/p, can exceed 100%)
    address public owner;

    error OnlyPoolManager();
    error Expired();
    error Slippage();
    error NotGraduated();
    error ZeroAmount();
    error ZeroRecipient();
    error ZeroMinOut();
    error PriceImpactTooHigh(uint256 impactBps, uint256 maxImpactBps);
    error OnlyOwner();
    error BadParam();
    error QuoteResult(uint256 amountOut, uint256 impactBps, uint256 mcapAfterUsd);
    error RouteResult(uint256 amountOut, uint256 maxHopImpactBps);
    error UsdgNotConfigured();
    error NoUsdgPool(address quote);
    error BadPool();
    error UnknownToken(address token);
    error Reentrancy();

    // ───────────────────────── USDG routing (buyWithUsdg / sellToUsdg) ─────────────────────────
    /// @notice USDG (the frontend's only payment asset). Owner-set together with `launchpad`.
    address public usdg;
    /// @notice Launchpad used as the curve registry (`curveOf(token)`) for pre-graduation routing.
    address public launchpad;
    /// @dev quote asset => registered USDG/quote v4 pool (owner-managed allowlist).
    mapping(address => PoolKey) internal _usdgPool;

    event UsdgRoutingSet(address indexed usdg, address indexed launchpad);
    event UsdgPoolSet(address indexed quote, PoolKey key);
    event UsdgPoolRemoved(address indexed quote);
    event UsdgTrade(
        address indexed trader, address indexed token, bool isBuy, uint256 amountIn, uint256 amountOut, bool viaCurve
    );

    struct Hop {
        PoolKey key;
        bool zeroForOne;
        bool disciple; // DISCIPLE (hooked) pool: impact via hook meta + trader hookData
    }

    /// @dev Multi-hop exact-in through one unlock. Intermediate deltas net out inside the PoolManager.
    struct RouteData {
        address payer; // address(this) = router-held funds
        address recipient;
        Hop[] hops;
        uint256 amountIn;
        bool simulate;
        address curveAfter; // simulate only: price the output through curve.quoteBuy
    }

    struct CallbackData {
        address payer;
        address recipient;
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        bool simulate;
    }

    constructor(IPoolManager poolManager_, LockedLP lockedLP_, address hook_) {
        poolManager = poolManager_;
        lockedLP = lockedLP_;
        hook = hook_;
        owner = msg.sender;
    }

    event MaxImpactSet(uint256 maxImpactBps);
    event OwnerTransferred(address indexed owner);

    function setMaxImpactBps(uint256 bps) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (bps < MIN_MAX_IMPACT_BPS || bps > MAX_MAX_IMPACT_BPS) revert BadParam();
        maxImpactBps = bps;
        emit MaxImpactSet(bps);
    }

    /// @notice Configure USDG routing (owner). `launchpad` is the curve registry used before graduation.
    function setUsdgRouting(address usdg_, address launchpad_) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (usdg_ == address(0) || launchpad_ == address(0)) revert BadParam();
        usdg = usdg_;
        launchpad = launchpad_;
        emit UsdgRoutingSet(usdg_, launchpad_);
    }

    /// @notice Register the USDG/`quote` v4 pool used for the USDG hop (owner allowlist).
    /// @dev The pool must pair exactly USDG and `quote`, and must not be a DISCIPLE (hooked) pool.
    function setUsdgPool(address quote, PoolKey calldata key) external {
        if (msg.sender != owner) revert OnlyOwner();
        address u = usdg;
        if (u == address(0)) revert UsdgNotConfigured();
        if (quote == address(0) || quote == u) revert BadParam();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (!((c0 == u && c1 == quote) || (c0 == quote && c1 == u))) revert BadPool();
        if (address(key.hooks) == hook) revert BadPool();
        (uint160 sp,,,) = poolManager.getSlot0(key.toId());
        if (sp == 0) revert BadPool(); // must be initialized
        _usdgPool[quote] = key;
        emit UsdgPoolSet(quote, key);
    }

    function removeUsdgPool(address quote) external {
        if (msg.sender != owner) revert OnlyOwner();
        delete _usdgPool[quote];
        emit UsdgPoolRemoved(quote);
    }

    function usdgPoolOf(address quote) external view returns (PoolKey memory) {
        return _usdgPool[quote];
    }

    function transferOwnership(address o) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (o == address(0)) revert ZeroRecipient();
        owner = o;
        emit OwnerTransferred(o);
    }

    /// @notice The graduated v4 pool key for `token` (reverts if not graduated).
    function poolKeyOf(address token) public view returns (PoolKey memory key) {
        key = lockedLP.getPoolKey(token);
        if (address(key.hooks) != hook || address(key.hooks) == address(0)) revert NotGraduated();
    }

    /// @notice Exact-in buy: spend `quoteIn` of the pool's quote asset for `token`, sent to `recipient`.
    function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline)
        public
        returns (uint256 tokensOut)
    {
        PoolKey memory key = poolKeyOf(token);
        bool tokenIsC0 = Currency.unwrap(key.currency0) == token;
        // buying token: quote → token
        tokensOut = _swap(key, !tokenIsC0, quoteIn, minTokensOut, recipient, deadline);
    }

    /// @notice Exact-in sell: sell `tokensIn` of `token` for the quote asset, sent to `recipient`.
    function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline)
        public
        returns (uint256 quoteOut)
    {
        PoolKey memory key = poolKeyOf(token);
        bool tokenIsC0 = Currency.unwrap(key.currency0) == token;
        quoteOut = _swap(key, tokenIsC0, tokensIn, minQuoteOut, recipient, deadline);
    }

    /// @notice buyExactIn with an EIP-2612 permit on the quote asset (try/catch: front-run safe).
    function buyExactInWithPermit(
        address token,
        uint256 quoteIn,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        PoolKey memory key = poolKeyOf(token);
        address q =
            Currency.unwrap(key.currency0) == token ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        try IERC20Permit(q).permit(msg.sender, address(this), quoteIn, deadline, v, r, s) {} catch {}
        return buyExactIn(token, quoteIn, minTokensOut, recipient, deadline);
    }

    /// @notice sellExactIn with an EIP-2612 permit on the launch token.
    function sellExactInWithPermit(
        address token,
        uint256 tokensIn,
        uint256 minQuoteOut,
        address recipient,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        try IERC20Permit(token).permit(msg.sender, address(this), tokensIn, deadline, v, r, s) {} catch {}
        return sellExactIn(token, tokensIn, minQuoteOut, recipient, deadline);
    }

    /// @notice Exact-in quote incl. the 1% hook fee, by simulating the swap and reverting.
    /// @dev Not `view` (v4 has no view swaps) — call it with eth_call / viem `simulateContract`.
    /// @return amountOut   net output to the trader
    /// @return impactBps   unsigned |Δprice|/price in bps (direction = isBuy), same semantics as Trade.impactBps
    /// @return mcapAfterUsd USD WAD at launch-time quote/USD price, same as Trade.mcapAfterUsd
    function quoteExactIn(address token, bool isBuy, uint256 amountIn)
        external
        returns (uint256 amountOut, uint256 impactBps, uint256 mcapAfterUsd)
    {
        PoolKey memory key = poolKeyOf(token);
        bool tokenIsC0 = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = isBuy ? !tokenIsC0 : tokenIsC0;
        try poolManager.unlock(
            _wrap0(
                CallbackData({
                    payer: address(0),
                    recipient: address(0),
                    key: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    simulate: true
                })
            )
        ) {
            revert();
        } catch (bytes memory reason) {
            if (reason.length != 100 || bytes4(reason) != QuoteResult.selector) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            assembly ("memory-safe") {
                amountOut := mload(add(reason, 36))
                impactBps := mload(add(reason, 68))
                mcapAfterUsd := mload(add(reason, 100))
            }
        }
    }

    // ───────────────────────── USDG entry points ─────────────────────────

    /// @notice Pay `usdgIn` USDG, receive `token` (to msg.sender). Routes USDG→quote via the registered pool (skipped
    ///         when the coin's quote is USDG), then the bonding curve (pre-grad) or the coin's v4 pool (post-grad).
    /// @param minTokensOut end-to-end minimum, in token units (must be > 0)
    function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        _enter();
        _preflight(usdgIn, minTokensOut, deadline);
        address u = usdg;
        (address curve, address q, bool grad, PoolKey memory dkey) = _market(token);
        if (grad) {
            Hop[] memory hops = _buyHops(u, q, token, dkey);
            tokensOut = _route(msg.sender, msg.sender, hops, usdgIn);
        } else {
            // Pre-grad: deliver quote STRAIGHT to the curve (v4 take → curve, or USDG transferFrom user → curve) and
            // let the curve trade for the real trader (caps, login, cost basis, attribution). No router custody,
            // no approvals; the curve enforces the router impact cap on its exact quote; refunds go to the trader.
            uint256 quoteAmt = usdgIn;
            if (q != u) {
                Hop[] memory h = new Hop[](1);
                h[0] = _usdgHop(u, q, true);
                quoteAmt = _route(msg.sender, curve, h, usdgIn);
            } else {
                IERC20(u).safeTransferFrom(msg.sender, curve, usdgIn);
            }
            tokensOut = IUsdgCurve(curve).routerBuy(msg.sender, quoteAmt, minTokensOut, deadline, maxImpactBps);
        }
        if (tokensOut < minTokensOut) revert Slippage();
        emit UsdgTrade(msg.sender, token, true, usdgIn, tokensOut, !grad);
        _exit();
    }

    /// @notice Sell `tokensIn` of `token` (from msg.sender) for USDG (to msg.sender).
    /// @param minUsdgOut end-to-end minimum, in USDG units (must be > 0)
    function sellToUsdg(address token, uint256 tokensIn, uint256 minUsdgOut, uint256 deadline)
        external
        returns (uint256 usdgOut)
    {
        _enter();
        _preflight(tokensIn, minUsdgOut, deadline);
        address u = usdg;
        (address curve, address q, bool grad, PoolKey memory dkey) = _market(token);
        if (grad) {
            Hop[] memory hops = _sellHops(u, q, token, dkey);
            usdgOut = _route(msg.sender, msg.sender, hops, tokensIn);
        } else {
            // Tokens go user → curve directly; the curve books the sell against the real trader (fixes the old
            // side effect where router-mediated sells debited/credited the router address).
            IERC20(token).safeTransferFrom(msg.sender, curve, tokensIn);
            uint256 cap = maxImpactBps;
            if (q == u) {
                usdgOut = IUsdgCurve(curve).routerSell(msg.sender, tokensIn, 1, deadline, msg.sender, cap);
            } else {
                uint256 quoteAmt = IUsdgCurve(curve).routerSell(msg.sender, tokensIn, 1, deadline, address(this), cap);
                Hop[] memory h = new Hop[](1);
                h[0] = _usdgHop(u, q, false);
                usdgOut = _route(address(this), msg.sender, h, quoteAmt);
            }
        }
        if (usdgOut < minUsdgOut) revert Slippage();
        emit UsdgTrade(msg.sender, token, false, tokensIn, usdgOut, !grad);
        _exit();
    }

    /// @notice Exact-in USDG route quote (simulate-and-revert; call via eth_call). Includes all fees.
    /// @return amountOut tokens out (isBuy) or USDG out (sell)
    /// @return maxHopImpactBps the largest per-hop price impact (the router reverts above `maxImpactBps`)
    function quoteUsdgRoute(address token, bool isBuy, uint256 amountIn)
        public
        returns (uint256 amountOut, uint256 maxHopImpactBps)
    {
        address u = usdg;
        if (u == address(0)) revert UsdgNotConfigured();
        (address curve, address q, bool grad, PoolKey memory dkey) = _market(token);
        if (grad) {
            Hop[] memory hops = isBuy ? _buyHops(u, q, token, dkey) : _sellHops(u, q, token, dkey);
            return _simulate(hops, amountIn, address(0));
        }
        // Curve quotes are for the caller (eth_call `from`): mode caps, PVE login and the PVE profit tax apply.
        if (isBuy) {
            if (q == u) return _curveBuyQuote(curve, msg.sender, amountIn);
            Hop[] memory h = new Hop[](1);
            h[0] = _usdgHop(u, q, true);
            return _simulate(h, amountIn, curve);
        }
        (uint256 qOut, uint256 cImp) = _curveSellQuote(curve, msg.sender, amountIn);
        if (q == u) return (qOut, cImp);
        Hop[] memory h2 = new Hop[](1);
        h2[0] = _usdgHop(u, q, false);
        (amountOut, maxHopImpactBps) = _simulate(h2, qOut, address(0));
        if (cImp > maxHopImpactBps) maxHopImpactBps = cImp;
    }

    function quoteBuyWithUsdg(address token, uint256 usdgIn) external returns (uint256 tokensOut, uint256 impactBps) {
        return quoteUsdgRoute(token, true, usdgIn);
    }

    function quoteSellToUsdg(address token, uint256 tokensIn) external returns (uint256 usdgOut, uint256 impactBps) {
        return quoteUsdgRoute(token, false, tokensIn);
    }

    // ───────────────────────── USDG routing internals ─────────────────────────

    bytes32 private constant LOCK_SLOT = keccak256("disciple.router.usdgLock");

    function _enter() private {
        bytes32 slot = LOCK_SLOT;
        uint256 v;
        assembly ("memory-safe") {
            v := tload(slot)
        }
        if (v != 0) revert Reentrancy();
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }

    function _exit() private {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    function _preflight(uint256 amountIn, uint256 minOut, uint256 deadline) private view {
        if (usdg == address(0)) revert UsdgNotConfigured();
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        if (minOut == 0) revert ZeroMinOut();
    }

    /// @dev Resolves the coin's market: curve + quote, and the graduated v4 key when graduated.
    function _market(address token) private view returns (address curve, address q, bool grad, PoolKey memory key) {
        address lp = launchpad;
        if (lp == address(0)) revert UsdgNotConfigured();
        curve = ILaunchpadCurveOf(lp).curveOf(token);
        if (curve == address(0)) revert UnknownToken(token);
        q = IUsdgCurve(curve).quote();
        grad = IUsdgCurve(curve).graduated();
        if (grad) key = poolKeyOf(token);
    }

    function _usdgHop(address u, address q, bool usdgToQuote) private view returns (Hop memory h) {
        h.key = _usdgPool[q];
        if (h.key.tickSpacing == 0) revert NoUsdgPool(q);
        bool usdgIsC0 = Currency.unwrap(h.key.currency0) == u;
        h.zeroForOne = usdgToQuote ? usdgIsC0 : !usdgIsC0;
    }

    function _buyHops(address u, address q, address token, PoolKey memory dkey) private view returns (Hop[] memory h) {
        bool tokenIsC0 = Currency.unwrap(dkey.currency0) == token;
        Hop memory d = Hop({key: dkey, zeroForOne: !tokenIsC0, disciple: true});
        if (q == u) {
            h = new Hop[](1);
            h[0] = d;
        } else {
            h = new Hop[](2);
            h[0] = _usdgHop(u, q, true);
            h[1] = d;
        }
    }

    function _sellHops(address u, address q, address token, PoolKey memory dkey) private view returns (Hop[] memory h) {
        bool tokenIsC0 = Currency.unwrap(dkey.currency0) == token;
        Hop memory d = Hop({key: dkey, zeroForOne: tokenIsC0, disciple: true});
        if (q == u) {
            h = new Hop[](1);
            h[0] = d;
        } else {
            h = new Hop[](2);
            h[0] = d;
            h[1] = _usdgHop(u, q, false);
        }
    }

    function _route(address payer, address recipient, Hop[] memory hops, uint256 amountIn)
        private
        returns (uint256 out)
    {
        bytes memory res = poolManager.unlock(
            abi.encode(
                uint8(1),
                abi.encode(
                    RouteData({
                        payer: payer,
                        recipient: recipient,
                        hops: hops,
                        amountIn: amountIn,
                        simulate: false,
                        curveAfter: address(0)
                    })
                )
            )
        );
        out = abi.decode(res, (uint256));
    }

    function _simulate(Hop[] memory hops, uint256 amountIn, address curveAfter)
        private
        returns (uint256 out, uint256 maxImpact)
    {
        bytes memory data = abi.encode(
            uint8(1),
            abi.encode(
                RouteData({
                    payer: msg.sender, // simulate: the quoted trader (curveAfter quote + hook attribution only)
                    recipient: address(0),
                    hops: hops,
                    amountIn: amountIn,
                    simulate: true,
                    curveAfter: curveAfter
                })
            )
        );
        try poolManager.unlock(data) {
            revert();
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != RouteResult.selector) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            assembly ("memory-safe") {
                out := mload(add(reason, 36))
                maxImpact := mload(add(reason, 68))
            }
        }
    }

    function _curveBuyQuote(address curve, address trader, uint256 quoteIn)
        private
        view
        returns (uint256 out, uint256 impact)
    {
        (bool ok, bytes memory r) =
            curve.staticcall(abi.encodeWithSignature("quoteBuyFor(address,uint256)", trader, quoteIn));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(r, 32), mload(r))
            }
        }
        IUsdgCurve.BuyQuoteLite memory bq = abi.decode(r, (IUsdgCurve.BuyQuoteLite));
        return (bq.tokensOut, bq.impactBps);
    }

    /// @dev SellQuote layout: (quoteOut, fee, grossQuote, priceAfterX18, impactBps, mcapAfterUsd, profitTax)
    function _curveSellQuote(address curve, address trader, uint256 tokensIn)
        private
        view
        returns (uint256 out, uint256 impact)
    {
        (bool ok, bytes memory r) =
            curve.staticcall(abi.encodeWithSignature("quoteSellFor(address,uint256)", trader, tokensIn));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(r, 32), mload(r))
            }
        }
        (out,,,, impact,) = abi.decode(r, (uint256, uint256, uint256, uint256, uint256, uint256));
    }

    /// @dev Same |Δp|/p metric as DiscipleHook.impactBpsFromSqrt, with the non-USDG side as the priced asset.
    function _impactFromSqrt(uint160 sb, uint160 sa, bool assetIsC0) private pure returns (uint256) {
        if (sb == 0 || sa == 0) return 0;
        uint256 d = sa > sb ? uint256(sa - sb) : uint256(sb - sa);
        uint256 sum = uint256(sa) + uint256(sb);
        uint256 denomRoot = assetIsC0 ? sb : sa;
        return Math.mulDiv(Math.mulDiv(d, sum, denomRoot), Constants.BPS_DENOM, denomRoot);
    }

    function _hopImpact(Hop memory h, uint160 sb) private view returns (uint256) {
        (uint160 sa,,,) = poolManager.getSlot0(h.key.toId());
        if (h.disciple) {
            (address tokenAddr,,,,) = DiscipleHook(hook).metaOf(h.key.toId());
            return DiscipleHook(hook).impactBpsFromSqrt(sb, sa, Currency.unwrap(h.key.currency0) == tokenAddr);
        }
        return _impactFromSqrt(sb, sa, Currency.unwrap(h.key.currency0) != usdg);
    }

    function _routeCallback(RouteData memory d) private returns (bytes memory) {
        uint256 amt = d.amountIn;
        uint256 maxImp;
        uint256 cap = maxImpactBps;
        uint256 firstPaid;
        uint256 n = d.hops.length;
        for (uint256 i; i < n; ++i) {
            Hop memory h = d.hops[i];
            (uint160 sb,,,) = poolManager.getSlot0(h.key.toId());
            BalanceDelta delta = poolManager.swap(
                h.key,
                IPoolManager.SwapParams({
                    zeroForOne: h.zeroForOne,
                    amountSpecified: -int256(amt),
                    sqrtPriceLimitX96: h.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                h.disciple ? abi.encode(d.payer == address(this) ? d.recipient : d.payer) : bytes("")
            );
            int128 dIn = h.zeroForOne ? delta.amount0() : delta.amount1();
            int128 dOut = h.zeroForOne ? delta.amount1() : delta.amount0();
            uint256 paid = uint256(uint128(-dIn));
            if (i == 0) firstPaid = paid;
            else if (paid != amt) revert BadPool(); // partial fill of an intermediate hop: never strand deltas
            amt = uint256(uint128(dOut));
            uint256 imp = _hopImpact(h, sb);
            if (imp > maxImp) maxImp = imp;
            if (!d.simulate && imp > cap) revert PriceImpactTooHigh(imp, cap);
        }
        if (d.simulate) {
            if (d.curveAfter != address(0)) {
                (uint256 t, uint256 ci) = _curveBuyQuote(d.curveAfter, d.payer, amt);
                amt = t;
                if (ci > maxImp) maxImp = ci;
            }
            revert RouteResult(amt, maxImp);
        }
        Hop memory first = d.hops[0];
        Hop memory last = d.hops[n - 1];
        Currency cin = first.zeroForOne ? first.key.currency0 : first.key.currency1;
        Currency cout = last.zeroForOne ? last.key.currency1 : last.key.currency0;
        cin.settle(poolManager, d.payer, firstPaid, false);
        cout.take(poolManager, d.recipient, amt, false);
        return abi.encode(amt);
    }

    function _swap(
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroRecipient();
        if (minOut == 0) revert ZeroMinOut();
        bytes memory res = poolManager.unlock(
            _wrap0(
                CallbackData({
                    payer: msg.sender,
                    recipient: recipient,
                    key: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    simulate: false
                })
            )
        );
        amountOut = abi.decode(res, (uint256));
        if (amountOut < minOut) revert Slippage();
    }

    function _wrap0(CallbackData memory d) private pure returns (bytes memory) {
        return abi.encode(uint8(0), abi.encode(d));
    }

    bytes32 private constant SIM_SLOT = keccak256("disciple.router.simSqrtBefore");

    function _tstoreSqrt(uint160 v) private {
        bytes32 slot = SIM_SLOT;
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _revertQuote(CallbackData memory d, uint256 out) private view {
        uint160 sb;
        bytes32 slot = SIM_SLOT;
        assembly ("memory-safe") {
            sb := tload(slot)
        }
        (uint160 sa,,,) = poolManager.getSlot0(d.key.toId());
        // token is c0 iff buying means zeroForOne == false
        (address tokenAddr,,,,) = DiscipleHook(hook).metaOf(d.key.toId());
        // Audit #13: same live quote/USD as the hook's Trade event (falls back to launch price inside the hook).
        uint256 qpx = DiscipleHook(hook).quoteUsdOf(d.key.toId());
        bool tokenIsC0 = Currency.unwrap(d.key.currency0) == tokenAddr;
        uint256 impact = DiscipleHook(hook).impactBpsFromSqrt(sb, sa, tokenIsC0);
        uint256 mcap = DiscipleHook(hook).mcapUsdFromSqrt(sa, tokenIsC0, qpx);
        revert QuoteResult(out, impact, mcap);
    }

    function _checkImpact(PoolKey memory key, uint160 sb) private view {
        (uint160 sa,,,) = poolManager.getSlot0(key.toId());
        (address tokenAddr,,,,) = DiscipleHook(hook).metaOf(key.toId());
        uint256 impact = DiscipleHook(hook).impactBpsFromSqrt(sb, sa, Currency.unwrap(key.currency0) == tokenAddr);
        uint256 cap = maxImpactBps;
        if (impact > cap) revert PriceImpactTooHigh(impact, cap);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (uint8 kind, bytes memory payload) = abi.decode(raw, (uint8, bytes));
        if (kind == 1) return _routeCallback(abi.decode(payload, (RouteData)));
        CallbackData memory d = abi.decode(payload, (CallbackData));

        (uint160 sqrtBefore,,,) = poolManager.getSlot0(d.key.toId());
        if (d.simulate) _tstoreSqrt(sqrtBefore);
        BalanceDelta delta = poolManager.swap(
            d.key,
            IPoolManager.SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            abi.encode(d.payer) // hook attributes trade/referral to the real trader
        );

        (Currency cin, Currency cout) =
            d.zeroForOne ? (d.key.currency0, d.key.currency1) : (d.key.currency1, d.key.currency0);
        int128 dIn = d.zeroForOne ? delta.amount0() : delta.amount1();
        int128 dOut = d.zeroForOne ? delta.amount1() : delta.amount0();

        uint256 paid = uint256(uint128(-dIn));
        uint256 out = uint256(uint128(dOut));
        if (d.simulate) _revertQuote(d, out);
        _checkImpact(d.key, sqrtBefore);
        cin.settle(poolManager, d.payer, paid, false);
        cout.take(poolManager, d.recipient, out, false);
        return abi.encode(out);
    }
}

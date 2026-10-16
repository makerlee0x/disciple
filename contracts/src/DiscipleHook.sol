// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {Constants} from "./libraries/Constants.sol";
import {ITradeEvents} from "./interfaces/ITradeEvents.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IQuotePricer} from "./interfaces/IQuotePricer.sol";
import {IAltitudeEvents} from "./interfaces/IAltitudeEvents.sol";
import {TwapOracle} from "./libraries/TwapOracle.sol";
import {Altitude} from "./libraries/Altitude.sol";

/// @title Post-grad 1% trade-fee hook (§3 / LOCKED #11)
/// @notice Pool LP fee is 0; this hook takes 1% of swap output and routes via FeeRouter (33/33/33/1).
/// @dev Must be mined to an address with
///      BEFORE_ADD_LIQUIDITY_FLAG | BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG.
///      beforeSwap snapshots sqrtPrice (transient) for the Trade event and writes the pool's TWAP oracle
///      (pre-swap tick, once per block, truncated). afterSwap emits Trade + AltitudeUpdate (TWAP) + TierBreak.
///      beforeAddLiquidity (SEC-02): only allowlisted liquidity managers (LockedLP, TrampWallManager) may add,
///      so nobody can JIT raw v4 positions around a swap; TrampWallManager enforces hold time + fee vesting.
contract DiscipleHook is IHooks, ITradeEvents, IAltitudeEvents {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IFeeRouter public immutable feeRouter;

    struct PoolMeta {
        address token;
        address quote;
        address creator;
        bool registered;
        uint256 quotePriceUsd; // launch-time USD WAD per 1e18 raw quote (for mcapAfterUsd)
    }

    /// @notice Allowlisted routers (DiscipleRouter, Uniswap UniversalRouter, ...). When the swap `sender` is
    ///         trusted and hookData is exactly abi.encode(address trader), that trader is credited (Trade event +
    ///         referral). Otherwise the `sender` itself is the trader (no referral unless sender is referred).
    mapping(address => bool) public isTrustedRouter;
    address public admin;

    /// @notice Fee-currency amount donated to in-range LPs on this swap.
    event LPDonation(address indexed token, address indexed currency, uint256 amount);
    event TrustedRouterSet(address indexed router, bool trusted);
    event AdminTransferred(address indexed admin);

    /// @dev transient slot for pre-swap sqrtPriceX96
    bytes32 private constant PRICE_SLOT = keccak256("disciple.hook.sqrtPriceBefore");

    mapping(PoolId => PoolMeta) public metaOf;

    address public migration;

    error OnlyPoolManager();
    error OnlyMigration();
    error HookNotImplemented();
    error NotRegistered();
    error OnlyAdmin();
    error OnlyLiquidityManager();
    error BadParam();

    // ── SEC-02 / SEC-03 / altitude TWAP ─────────────────────────────────────
    /// @notice Contracts allowed to add liquidity to DISCIPLE pools (LockedLP, TrampWallManager).
    mapping(address => bool) public isLiquidityManager;
    /// @notice Max |tick change| recorded per oracle observation (truncated oracle). 9116 ≈ ×2.49 per block.
    int24 public maxTickDelta = 9116;
    /// @notice TWAP window (seconds) for altitude tiers. Owner(admin)-settable.
    uint32 public altitudeWindow = 300;
    /// @notice Last TWAP altitude tier per pool (0..17).
    mapping(PoolId => uint8) public altitudeTierOf;
    mapping(PoolId => TwapOracle.State) internal _oracle;

    event LiquidityManagerSet(address indexed manager, bool allowed);
    event AltitudeWindowSet(uint32 window);
    event MaxTickDeltaSet(int24 maxTickDelta);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_, IFeeRouter feeRouter_, address migration_, address admin_) {
        admin = admin_;
        poolManager = poolManager_;
        feeRouter = feeRouter_;
        migration = migration_;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    function setMigration(address m) external {
        // one-time wire if constructed with address(0)
        require(migration == address(0) || msg.sender == migration, "DiscipleHook: mig");
        migration = m;
    }

    function setTrustedRouter(address r, bool trusted) external {
        if (msg.sender != admin) revert OnlyAdmin();
        isTrustedRouter[r] = trusted;
        emit TrustedRouterSet(r, trusted);
    }

    /// @notice Live quote/USD oracle for Trade-event mcap (falls back to launch-time price if unset/reverts).
    IQuotePricer public pricer;

    function setPricer(address p) external {
        if (msg.sender != admin) revert OnlyAdmin();
        pricer = IQuotePricer(p);
    }

    function _quoteUsd(PoolMeta memory m) internal view returns (uint256) {
        if (address(pricer) != address(0)) {
            try pricer.quotePriceUsd(m.quote) returns (uint256 p) {
                if (p > 0) return p;
            } catch {}
        }
        return m.quotePriceUsd;
    }

    function setLiquidityManager(address mgr, bool allowed) external {
        if (msg.sender != admin) revert OnlyAdmin();
        isLiquidityManager[mgr] = allowed;
        emit LiquidityManagerSet(mgr, allowed);
    }

    /// @param w seconds, 1..86400
    function setAltitudeWindow(uint32 w) external {
        if (msg.sender != admin) revert OnlyAdmin();
        if (w == 0 || w > 1 days) revert BadParam();
        altitudeWindow = w;
        emit AltitudeWindowSet(w);
    }

    /// @param d ticks, 1..887272 (887272 ≈ no truncation)
    function setMaxTickDelta(int24 d) external {
        if (msg.sender != admin) revert OnlyAdmin();
        if (d <= 0) revert BadParam();
        maxTickDelta = d;
        emit MaxTickDeltaSet(d);
    }

    function transferAdmin(address a) external {
        if (msg.sender != admin) revert OnlyAdmin();
        admin = a;
        emit AdminTransferred(a);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Called by Migration at graduation to bind pool → token/quote/creator.
    function registerPool(PoolKey calldata key, address token, address quote, address creator, uint256 quotePriceUsd)
        external
    {
        if (msg.sender != migration) revert OnlyMigration();
        PoolId id = key.toId();
        PoolMeta memory m =
            PoolMeta({token: token, quote: quote, creator: creator, registered: true, quotePriceUsd: quotePriceUsd});
        metaOf[id] = m;
        // Oracle starts at the seeded (curve-end) price, which is set atomically by Migration.
        int24 t = _tokenTick(key, token);
        TwapOracle.initialize(_oracle[id], t);
        uint256 mcap = TwapOracle.mcapUsdAtTick(t, Constants.TOTAL_SUPPLY, _quoteUsd(m));
        uint8 tier = Altitude.tierOf(mcap);
        altitudeTierOf[id] = tier;
        emit AltitudeUpdate(token, mcap, mcap, tier, 0);
    }

    /// @dev Pool tick in quote-per-token orientation.
    function _tokenTick(PoolKey calldata key, address token) internal view returns (int24) {
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        return Currency.unwrap(key.currency0) == token ? tick : -tick;
    }

    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(id);
        bytes32 slot = PRICE_SLOT;
        assembly ("memory-safe") {
            tstore(slot, sqrtP)
        }
        address token = metaOf[id].token;
        if (token != address(0)) {
            // Pre-swap tick, once per block, truncated → a same-block pump has zero TWAP weight.
            TwapOracle.write(_oracle[id], Currency.unwrap(key.currency0) == token ? tick : -tick, maxTickDelta, false);
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, int128) {
        PoolMeta memory m = metaOf[key.toId()];
        if (!m.registered) revert NotRegistered();

        // Fee on unspecified (output) token — same pattern as FeeTakingHook
        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        uint256 feeAmount = uint256(uint128(swapAmount)) * Constants.TRADE_FEE_BPS / Constants.BPS_DENOM;
        address trader = sender;
        if (hookData.length == 32 && isTrustedRouter[sender]) {
            trader = abi.decode(hookData, (address));
        }

        address feeToken = Currency.unwrap(feeCurrency);
        if (feeAmount > 0) {
            // 1/3 of the 33% LP share → donated to in-range LPs (tramps/walls + LockedLP full-range)
            uint256 donated = _donateToLPs(key, feeCurrency, feeAmount);
            uint256 routed = feeAmount - donated;
            poolManager.take(feeCurrency, address(this), routed);
            IERC20(feeToken).safeTransfer(address(feeRouter), routed);
            // For FeeRouter the `quote` param is the fee asset being split
            feeRouter.routeHookFee(m.token, feeToken, trader, m.creator, feeAmount, donated);
            emit LPDonation(m.token, feeToken, donated);
        }

        uint256 qUsd = _quoteUsd(m);
        uint256 spotMcap = _emitTrade(key, m, trader, delta, feeToken, feeAmount, qUsd);
        _emitAltitude(key, m, spotMcap, qUsd);
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    /// @notice Donated share of the hook fee: 33% LP share / 3 = 11% of the 1% fee.
    function donationOf(uint256 feeAmount) public pure returns (uint256) {
        return (feeAmount * Constants.FEE_SHARE_LP_LOCK) / Constants.FEE_SHARE_DENOM / 3;
    }

    /// @dev Donates in the fee currency (whichever side the fee was charged on: quote for sells / exact-out buys,
    ///      token for exact-in buys). Skipped if the pool has no in-range liquidity (v4 donate would revert).
    function _donateToLPs(PoolKey calldata key, Currency feeCurrency, uint256 feeAmount)
        internal
        returns (uint256 donated)
    {
        donated = donationOf(feeAmount);
        if (donated == 0 || poolManager.getLiquidity(key.toId()) == 0) return 0;
        bool is0 = Currency.unwrap(feeCurrency) == Currency.unwrap(key.currency0);
        poolManager.donate(key, is0 ? donated : 0, is0 ? 0 : donated, "");
    }

    function _emitTrade(
        PoolKey calldata key,
        PoolMeta memory m,
        address trader,
        BalanceDelta delta,
        address feeToken,
        uint256 feeAmount,
        uint256 qUsd
    ) internal returns (uint256 mcap) {
        bool tokenIsC0 = Currency.unwrap(key.currency0) == m.token;
        int128 dToken = tokenIsC0 ? delta.amount0() : delta.amount1();
        int128 dQuote = tokenIsC0 ? delta.amount1() : delta.amount0();
        bool isBuy = dToken > 0; // swapper receives token
        uint256 tokenAmt = _abs(dToken);
        uint256 quoteAmt = _abs(dQuote);
        // Net out the hook fee from the side it was charged on (output side for exact-in)
        bool feeInToken = feeToken == m.token;
        if (feeInToken) tokenAmt = isBuy ? tokenAmt - feeAmount : tokenAmt + feeAmount;
        else quoteAmt = isBuy ? quoteAmt + feeAmount : quoteAmt - feeAmount;

        uint160 sqrtBefore;
        bytes32 slot = PRICE_SLOT;
        assembly ("memory-safe") {
            sqrtBefore := tload(slot)
        }
        (uint160 sqrtAfter,,,) = poolManager.getSlot0(key.toId());
        uint256 pAfter = priceX18FromSqrt(sqrtAfter, tokenIsC0);
        uint256 feeQuote = feeInToken ? Math.mulDiv(feeAmount, pAfter, 1e18) : feeAmount;
        mcap = Math.mulDiv(Math.mulDiv(pAfter, Constants.TOTAL_SUPPLY, 1e18), qUsd, 1e18);

        emit Trade(
            m.token,
            trader,
            isBuy,
            quoteAmt,
            tokenAmt,
            feeQuote,
            0,
            priceX18FromSqrt(sqrtBefore, tokenIsC0),
            pAfter,
            impactBpsFromSqrt(sqrtBefore, sqrtAfter, tokenIsC0),
            mcap
        );
    }

    function _emitAltitude(PoolKey calldata key, PoolMeta memory m, uint256 spotMcap, uint256 qUsd) internal {
        PoolId id = key.toId();
        TwapOracle.State storage o = _oracle[id];
        (int24 mean, uint32 w) =
            TwapOracle.consult(o, altitudeWindow, TwapOracle.tail(o, _tokenTick(key, m.token), maxTickDelta));
        uint256 twapMcap = TwapOracle.mcapUsdAtTick(mean, Constants.TOTAL_SUPPLY, qUsd);
        uint8 tier = Altitude.tierOf(twapMcap);
        emit AltitudeUpdate(m.token, twapMcap, spotMcap, tier, w);
        uint8 prev = altitudeTierOf[id];
        if (tier != prev) {
            altitudeTierOf[id] = tier;
            emit TierBreak(m.token, prev, tier, twapMcap);
        }
    }

    // ── TWAP views (MarketLens / GAME / safety consumers) ──

    /// @notice Time-weighted mean tick (quote-per-token orientation) over `window` seconds.
    /// @return tick mean tick; actualWindow seconds covered (≤ window while the pool is young)
    function twapTick(PoolId id, uint32 window) public view returns (int24 tick, uint32 actualWindow) {
        PoolMeta memory m = metaOf[id];
        if (!m.registered) revert NotRegistered();
        TwapOracle.State storage o = _oracle[id];
        (, int24 t,,) = poolManager.getSlot0(id);
        (address c0,) = _sorted(m.token, m.quote);
        int24 spot = c0 == m.token ? t : -t;
        return TwapOracle.consult(o, window, TwapOracle.tail(o, spot, maxTickDelta));
    }

    /// @notice TWAP price, quote raw * 1e18 / token raw.
    function twapPriceX18(PoolId id, uint32 window) external view returns (uint256 priceX18, uint32 actualWindow) {
        int24 t;
        (t, actualWindow) = twapTick(id, window);
        priceX18 = TwapOracle.priceX18AtTick(t);
    }

    /// @notice TWAP market cap, USD WAD (quote/USD from the pricer, itself a TWAP).
    function twapMcapUsd(PoolId id, uint32 window) external view returns (uint256 mcapUsd, uint32 actualWindow) {
        int24 t;
        (t, actualWindow) = twapTick(id, window);
        mcapUsd = TwapOracle.mcapUsdAtTick(t, Constants.TOTAL_SUPPLY, _quoteUsd(metaOf[id]));
    }

    /// @notice Oracle ring state: (latest index, populated count, latest observation ts/tick).
    function oracleState(PoolId id) external view returns (uint16 index, uint16 count, uint32 lastTs, int24 lastTick) {
        TwapOracle.State storage o = _oracle[id];
        index = o.index;
        count = o.count;
        TwapOracle.Observation memory l = o.obs[o.index];
        lastTs = l.ts;
        lastTick = l.tick;
    }

    function _sorted(address a, address b) private pure returns (address, address) {
        return uint160(a) < uint160(b) ? (a, b) : (b, a);
    }

    /// @notice quote raw * 1e18 / token raw from a v4 sqrtPriceX96.
    function priceX18FromSqrt(uint160 sqrtP, bool tokenIsC0) public pure returns (uint256) {
        if (sqrtP == 0) return 0;
        uint256 pX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64); // c1 per c0, X128
        return tokenIsC0 ? Math.mulDiv(pX128, 1e18, 1 << 128) : Math.mulDiv(1 << 128, 1e18, pX128);
    }

    /// @notice |Δprice|/price in bps, price = quote per token, from sqrt prices (full precision).
    function impactBpsFromSqrt(uint160 sb, uint160 sa, bool tokenIsC0) public pure returns (uint256) {
        if (sb == 0 || sa == 0) return 0;
        uint256 d = sa > sb ? uint256(sa - sb) : uint256(sb - sa);
        uint256 sum = uint256(sa) + uint256(sb);
        // token c0: p ∝ s² → |sa²-sb²|/sb² ; token c1: p ∝ 1/s² → |sa²-sb²|/sa²
        uint256 denomRoot = tokenIsC0 ? sb : sa;
        return Math.mulDiv(Math.mulDiv(d, sum, denomRoot), Constants.BPS_DENOM, denomRoot);
    }

    function _abs(int128 x) private pure returns (uint256) {
        return uint256(uint128(x < 0 ? -x : x));
    }

    // ── unused hooks revert ──────────────────────────────────────────────────
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @dev SEC-02: raw v4 adds are blocked; only LockedLP / TrampWallManager (which enforces hold + vesting).
    function beforeAddLiquidity(
        address sender,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        if (!isLiquidityManager[sender]) revert OnlyLiquidityManager();
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}

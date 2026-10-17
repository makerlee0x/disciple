// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "./libraries/Constants.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {McapMath} from "./libraries/McapMath.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {IBondingCurve} from "./interfaces/IBondingCurve.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IAntiSnipe} from "./interfaces/IAntiSnipe.sol";
import {IMigration} from "./interfaces/IMigration.sol";
import {ITradeEvents} from "./interfaces/ITradeEvents.sol";
import {SqrtPrice} from "./libraries/SqrtPrice.sol";
import {Altitude} from "./libraries/Altitude.sol";
import {IAltitudeEvents} from "./interfaces/IAltitudeEvents.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

interface IMigrationPM {
    function poolManager() external view returns (IPoolManager);
}

interface IQuotePricerLite {
    function quotePriceUsd(address quote) external view returns (uint256);
}

interface ILaunchpadPricer {
    function pricer() external view returns (address);
}

interface ILaunchpadRouters {
    function isTrustedRouter(address r) external view returns (bool);
}

interface ILoginGate {
    function verifiedUntil(address wallet, address coin) external view returns (uint64);
}

interface IPveToken {
    function endPveHooks() external;
}

interface IFeeRouterCurve {
    function routeCurveFees(
        address token,
        address quote,
        address trader,
        address creator,
        uint256 protoFee,
        uint256 creatorTaxAmount,
        uint256 snipeFeeAmount
    ) external;
    function accrueTreasury(address asset, uint256 amount) external;
}

/// @title External bonding curve — Pump-style CPAMM (§2 / LOCKED #5–#8)
/// @notice Start mcap $7K → graduation (Outer Space) $33K at exactly 72% supply sold; 7% wallet cap.
/// @dev Single constant-product virtual reserves; quotePriceUsd scales USD targets into quote units.
/// @dev Altitude: after each Trade the SPOT mcap (Trade.mcapAfterUsd) is streamed as AltitudeUpdate, plus
///      TierBreak when the spot tier changes.
contract BondingCurve is IBondingCurve, ITradeEvents, IAltitudeEvents {
    using SafeERC20 for IERC20;

    address public immutable override token;
    address public immutable override quote;
    address public immutable creator;
    address public immutable launchpad;
    IFeeRouter public immutable feeRouter;
    IAntiSnipe public immutable antiSnipe;
    IMigration public immutable migration;

    uint256 public immutable creatorTaxBps; // immutable at launch (§3 / #12)
    uint256 public immutable quotePriceUsd; // USD WAD per 1e18 raw quote units (from QuotePricer at launch)
    /// @notice Per-wallet curve holding cap in bps of supply, snapshotted from Launchpad at launch (0 = no cap).
    uint256 public immutable walletCapBps;

    /// @notice Game mode chosen by the creator at launch (Constants.MODE_*), immutable. Curve-only.
    uint8 public immutable mode;
    /// @notice PVE login gate (EIP-712 attestations); address(0) for non-PVE coins.
    address public immutable loginGate;
    uint256 public immutable launchTime;
    uint256 public immutable launchBlock;
    /// @notice Primary trusted router snapshotted at launch (gas: no Launchpad call on its trades). Other routers
    ///         still go through Launchpad.isTrustedRouter.
    address public immutable trustedRouter;

    CurveMath.Params private _params;

    uint256 public override quoteReserve;
    uint256 public override tokensSold;
    bool public override graduated;
    /// @notice Audit round 3 (ops): protocol kill switch for this curve's cached `trustedRouter` (packed with
    ///         `graduated`, so the router path pays one warm read). Set via Launchpad.setCurveRouterKilled.
    bool public routerKilled;

    mapping(address => uint256) public balanceOnCurve; // for wallet cap tracking

    /// @notice Last spot altitude tier (0..17).
    uint8 public altitudeTier;

    // ── PVE state (unused / zero for PVP + TRENCH) ──
    struct Acct {
        uint128 cost; // quote paid for the current NET curve position (avg cost = cost / balanceOnCurve)
        uint64 verifiedUntil; // cached LoginGate expiry
    }

    mapping(address => Acct) internal _acct;
    /// @notice MasterChef reward debt (quote, 1e36-scaled accumulator) per holder.
    mapping(address => uint256) public rewardDebt;
    /// @notice Settled but unclaimed holder rewards (quote raw).
    mapping(address => uint256) public rewardsAccrued;
    uint256 internal constant ACC_SCALE = 1e36;
    /// @notice Profit-tax reward per NET curve token, scaled 1e36 (ACC_SCALE).
    uint256 public accRewardPerToken;
    /// @notice Sum of all NET curve positions (PVE only) — the accumulator denominator.
    uint256 public totalNet;
    /// @notice Quote held for PVE holder rewards (distributed, unclaimed). Curve quote balance >= quoteReserve +
    ///         rewardsHeld; router prepaid amounts are checked on top of it (audit L3).
    uint256 public rewardsHeld;

    error Graduated();
    error NotGraduated();
    error Expired();
    error Slippage();
    error WalletCap();
    error ZeroAmount();
    error OnlyLaunchpad();
    error ZeroRecipient();
    error NotRouter();
    error LaunchBlock();
    error NotVerified();
    error BuyTooLarge();
    error SellTooLarge();
    error PriceImpactTooHigh(uint256 impactBps, uint256 maxImpactBps);
    error NotPrepaid();
    error BadParams();
    error OnlyToken();

    event ProfitTaxCharged(
        address indexed token, address indexed seller, uint256 tax, uint256 grossQuote, uint256 costBasis
    );
    event HolderRewardsClaimed(address indexed token, address indexed holder, uint256 amount);

    event GraduatedToV4(address indexed token, bytes32 poolId, uint256 tokenLiq, uint256 quoteLiq);

    struct BuyQuote {
        uint256 tokensOut;
        uint256 fee; // protocol 1% + creator tax (quote raw)
        uint256 snipeFee; // current anti-snipe fee (quote raw)
        uint256 quoteToCurve;
        uint256 priceAfterX18;
        uint256 impactBps;
        uint256 mcapAfterUsd;
        bool graduates;
        uint256 refund; // audit #9: unused quote returned on the capped graduation buy (0 otherwise)
    }

    struct SellQuote {
        uint256 quoteOut; // net to seller
        uint256 fee;
        uint256 grossQuote;
        uint256 priceAfterX18;
        uint256 impactBps;
        uint256 mcapAfterUsd;
        uint256 profitTax; // PVE profit tax already deducted from quoteOut (quoteSellFor only)
    }

    constructor(
        address token_,
        address quote_,
        address creator_,
        address launchpad_,
        address feeRouter_,
        address antiSnipe_,
        address migration_,
        uint256 creatorTaxBps_,
        CurveMath.Params memory params_, // CurveMath.makeParams(quotePriceUsd), computed by the Launchpad (size)
        uint256 walletCapBps_,
        uint8 mode_,
        address loginGate_,
        address trustedRouter_
    ) {
        if (
            mode_ > Constants.MODE_PVP || (mode_ == Constants.MODE_PVE && loginGate_ == address(0))
                || walletCapBps_ > Constants.BPS_DENOM || creatorTaxBps_ > Constants.CREATOR_TAX_MAX_BPS
        ) revert BadParams();
        token = token_;
        quote = quote_;
        creator = creator_;
        launchpad = launchpad_;
        feeRouter = IFeeRouter(feeRouter_);
        antiSnipe = IAntiSnipe(antiSnipe_);
        migration = IMigration(migration_);
        creatorTaxBps = creatorTaxBps_;
        quotePriceUsd = params_.quotePriceUsd;
        walletCapBps = walletCapBps_;
        mode = mode_;
        loginGate = loginGate_;
        launchTime = block.timestamp;
        launchBlock = block.number;
        trustedRouter = trustedRouter_;

        _params = params_;
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Curve geometry (for off-chain / tests).
    function curveParams() external view returns (uint256 totalSupply, uint256 sCurve, uint256 x0, uint256 y0) {
        CurveMath.Params memory p = _params;
        return (p.totalSupply, p.sCurve, p.x0, p.y0);
    }

    /// @inheritdoc IBondingCurve
    /// @dev After graduation reads the live v4 pool price (was: frozen curve-end value).
    function marketCapUsd() public view override returns (uint256) {
        return Math.mulDiv(marketCapQuote(), _quoteUsdNow(), 1e18);
    }

    /// @notice Market cap in raw quote units, full precision (curve reserves pre-grad, v4 sqrtPrice post-grad).
    function marketCapQuote() public view returns (uint256) {
        if (!graduated) return CurveMath.marketCapQuote(_params, tokensSold);
        IPoolManager pm = IMigrationPM(address(migration)).poolManager();
        (uint160 sp,,,) = StateLibrary.getSlot0(pm, PoolId.wrap(migration.poolIdOf(token)));
        return McapMath.mcapQuoteFromSqrt(sp, uint160(token) < uint160(quote), _params.totalSupply);
    }

    /// @dev Pre-grad: launch-time quote price (curve USD targets). Post-grad: live QuotePricer via Launchpad.
    function _quoteUsdNow() internal view returns (uint256) {
        if (!graduated) return quotePriceUsd;
        try ILaunchpadPricer(launchpad).pricer() returns (address p) {
            if (p != address(0)) {
                try IQuotePricerLite(p).quotePriceUsd(quote) returns (uint256 v) {
                    if (v > 0) return v;
                } catch {}
            }
        } catch {}
        return quotePriceUsd;
    }

    /// @notice Alias of marketCapUsd (USD WAD). Live v4 pool price once graduated.
    function mcapNow() external view returns (uint256) {
        return marketCapUsd();
    }

    /// @notice Spot price in quote wei * 1e18 / token wei (v4 pool slot0 once graduated).
    function spotPriceWad() public view returns (uint256) {
        if (!graduated) return CurveMath.spotPriceWad(_params, tokensSold);
        IPoolManager pm = IMigrationPM(address(migration)).poolManager();
        (uint160 sp,,,) = StateLibrary.getSlot0(pm, PoolId.wrap(migration.poolIdOf(token)));
        if (uint160(token) < uint160(quote)) return Math.mulDiv(Math.mulDiv(sp, sp, 1 << 64), 1e18, 1 << 128);
        return Math.mulDiv(Math.mulDiv(1e18, 1 << 96, sp), 1 << 96, sp);
    }

    /// @notice Alias of spotPriceWad (quote raw * 1e18 / token raw).
    function priceNow() external view returns (uint256) {
        return spotPriceWad();
    }

    /// @notice Progress to graduation in bps (tokensSold / 72% of supply). 10000 = graduated.
    function progressBps() external view returns (uint256) {
        if (graduated) return Constants.BPS_DENOM;
        return (tokensSold * Constants.BPS_DENOM) / _params.sCurve;
    }

    /// @notice Current anti-snipe fee in bps (77.7% → 0 over 7s after launch).
    function currentSnipeFeeBps() external view returns (uint256) {
        return antiSnipe.currentFeeBps(token);
    }

    /// @notice Exact preview of `buy(quoteIn, ...)` at the current block (incl. 1% fee, creator tax, anti-snipe).
    /// @dev Does not check wallet cap. Reverts when graduated.
    function quoteBuy(uint256 quoteIn) public view returns (BuyQuote memory q) {
        return _quoteBuy(quoteIn, false);
    }

    /// @dev `snipeExempt` = Launchpad creator buy (LOCKED #27: creator launch buy pays only the 1% protocol fee).
    function _quoteBuy(uint256 quoteIn, bool snipeExempt) internal view returns (BuyQuote memory q) {
        if (graduated) revert Graduated();
        q = _quoteBuyRaw(quoteIn, snipeExempt);
        // Audit #9: the final (graduating) buy is capped at the remaining curve supply. Charge only the quote
        // actually needed for those tokens (incl. its fees) and refund the rest instead of overpaying.
        uint256 remaining = _params.sCurve - tokensSold;
        if (q.tokensOut == remaining && remaining > 0) {
            uint256 needCurve = CurveMath.quoteInForTokens(_params, tokensSold, remaining) + 1;
            if (needCurve < q.quoteToCurve) {
                // DISCIPLE audit #8: binary search for the smallest spend that still buys `remaining` (the old 8-step
                // bump could stop early and overcharge). Start from the linear gross-up estimate; `hi` always buys
                // `remaining` (quoteIn does by construction), so the result is never worse than no refund.
                uint256 used = Math.mulDiv(needCurve, quoteIn, q.quoteToCurve, Math.Rounding.Ceil);
                uint256 lo;
                uint256 hi = quoteIn;
                if (used < quoteIn) {
                    uint256 probe = used + used / 1e9 + 1; // tight upper guess first (usually enough)
                    if (probe < quoteIn && _quoteBuyRaw(probe, snipeExempt).tokensOut >= remaining) hi = probe;
                    lo = used > 0 ? used - 1 : 0;
                    if (lo < hi && _quoteBuyRaw(lo, snipeExempt).tokensOut >= remaining) {
                        hi = lo;
                        lo = hi - hi / 1e6 - 1;
                        if (_quoteBuyRaw(lo, snipeExempt).tokensOut >= remaining) lo = 0;
                    }
                }
                // invariant: buys(hi) && (lo == 0 || !buys(lo)). Stop at 1e-12 relative precision (≤ 1e-12 overpay)
                // or 64 steps, whichever first.
                for (uint256 i; i < 64 && hi - lo > hi / 1e12 + 1; ++i) {
                    uint256 mid = lo + (hi - lo) / 2;
                    if (_quoteBuyRaw(mid, snipeExempt).tokensOut >= remaining) hi = mid;
                    else lo = mid;
                }
                if (hi < quoteIn) {
                    BuyQuote memory u = _quoteBuyRaw(hi, snipeExempt);
                    if (u.tokensOut < remaining) revert Slippage(); // fallback: never silently overcharge
                    u.tokensOut = remaining;
                    u.refund = quoteIn - hi;
                    q = u;
                }
            }
        }
    }

    function _quoteBuyRaw(uint256 quoteIn, bool snipeExempt) internal view returns (BuyQuote memory q) {
        // Gas: the anti-snipe window (registered in the same launch tx) is 7s and ends at 0 bps — skip the call after.
        if (!snipeExempt && block.timestamp < launchTime + Constants.ANTI_SNIPE_DURATION) {
            (q.snipeFee,) = antiSnipe.applyBuyFee(token, quoteIn);
        }
        uint256 afterSnipe = quoteIn - q.snipeFee;
        uint256 protoFee = FeeMath.protocolFee(afterSnipe);
        uint256 tax = FeeMath.creatorTax(afterSnipe, creatorTaxBps);
        q.fee = protoFee + tax;
        q.quoteToCurve = afterSnipe - q.fee;
        q.tokensOut = CurveMath.tokensOutForQuote(_params, tokensSold, q.quoteToCurve);
        uint256 sAfter = tokensSold + q.tokensOut;
        q.priceAfterX18 = CurveMath.spotPriceWad(_params, sAfter);
        q.impactBps = _impactBps(tokensSold, sAfter);
        q.mcapAfterUsd = CurveMath.marketCapUsd(_params, sAfter);
        q.graduates = sAfter >= _params.sCurve || q.mcapAfterUsd >= Constants.OUTER_SPACE_MCAP_USD;
    }

    /// @notice Exact preview of `sell(tokensIn, ...)` (incl. 1% fee + creator tax).
    function quoteSell(uint256 tokensIn) public view returns (SellQuote memory q) {
        if (graduated) revert Graduated();
        q.grossQuote = CurveMath.quoteOutForTokens(_params, tokensSold, tokensIn);
        q.fee = FeeMath.protocolFee(q.grossQuote) + FeeMath.creatorTax(q.grossQuote, creatorTaxBps);
        q.quoteOut = q.grossQuote - q.fee;
        uint256 sAfter = tokensSold - tokensIn;
        q.priceAfterX18 = CurveMath.spotPriceWad(_params, sAfter);
        q.impactBps = _impactBps(tokensSold, sAfter);
        q.mcapAfterUsd = CurveMath.marketCapUsd(_params, sAfter);
    }

    /// @dev Price ∝ 1/y² on a CPAMM (x = k/y): impact = |y0² - y1²| / y1², full precision.
    function _impactBps(uint256 sBefore, uint256 sAfter) internal view returns (uint256) {
        uint256 yb = _params.y0 - sBefore;
        uint256 ya = _params.y0 - sAfter;
        uint256 b2 = yb * yb;
        uint256 a2 = ya * ya;
        uint256 d = a2 > b2 ? a2 - b2 : b2 - a2;
        // priceBefore ∝ 1/b2 → impact relative to before = d / a2
        return Math.mulDiv(d, Constants.BPS_DENOM, a2);
    }

    // ───────────────────────────── mode views ─────────────────────────────

    /// @notice Current NET-position cap for a wallet in token wei (type(uint256).max = none).
    function netCapNow() public view returns (uint256) {
        uint8 m = mode;
        if (m == Constants.MODE_PVE) return FeeMath.walletCap(Constants.PVE_NET_CAP_BPS);
        if (m == Constants.MODE_PVP) {
            uint256 bps = Constants.PVP_CAP_START_BPS
                + ((Constants.PVP_CAP_END_BPS - Constants.PVP_CAP_START_BPS) * tokensSold) / _params.sCurve;
            return FeeMath.walletCap(bps);
        }
        return walletCapBps == 0 ? type(uint256).max : FeeMath.walletCap(walletCapBps);
    }

    /// @notice Current max tokens out for a single buy (type(uint256).max = none).
    function maxBuyNow() public view returns (uint256) {
        uint8 m = mode;
        if (m == Constants.MODE_PVE) {
            return block.timestamp < launchTime + Constants.PVE_WINDOW
                ? FeeMath.walletCap(Constants.PVE_WINDOW_BUY_CAP_BPS)
                : type(uint256).max;
        }
        if (m == Constants.MODE_PVP) return FeeMath.walletCap(Constants.PVP_MAX_BUY_BPS);
        return type(uint256).max;
    }

    /// @notice Max tokens in for a single curve sell (type(uint256).max = none).
    function maxSellNow() public view returns (uint256) {
        return mode == Constants.MODE_PVE ? FeeMath.walletCap(Constants.PVE_MAX_SELL_BPS) : type(uint256).max;
    }

    /// @notice PVE: quote paid for `wallet`'s current NET curve position (avg cost = costBasisOf / balanceOnCurve).
    function costBasisOf(address wallet) external view returns (uint256) {
        return _acct[wallet].cost;
    }

    /// @notice PVE: cached login expiry for `wallet` (0 = not cached; the gate is consulted on the next buy).
    function verifiedUntilOf(address wallet) external view returns (uint64) {
        return _acct[wallet].verifiedUntil;
    }

    /// @notice Claimable holder rewards (PVE profit-tax pool), quote raw. Works after graduation.
    function pendingRewards(address holder) public view returns (uint256) {
        return rewardsAccrued[holder] + Math.mulDiv(balanceOnCurve[holder], accRewardPerToken, ACC_SCALE)
            - rewardDebt[holder];
    }

    /// @notice quoteBuy for a specific trader, enforcing every mode rule exactly like the trade (reverts with the
    ///         same error the trade would). Use this (or the router quotes) for previews.
    function quoteBuyFor(address trader, uint256 quoteIn) external view returns (BuyQuote memory q) {
        q = _quoteBuy(quoteIn, false);
        _checkBuy(trader, q.tokensOut, false, true);
    }

    /// @notice quoteSell for a specific trader: enforces the PVE max sell and deducts the PVE profit tax.
    function quoteSellFor(address trader, uint256 tokensIn) public view returns (SellQuote memory q) {
        q = quoteSell(tokensIn);
        if (mode == Constants.MODE_PVE) {
            if (tokensIn > FeeMath.walletCap(Constants.PVE_MAX_SELL_BPS)) revert SellTooLarge();
            (uint256 tax,) = _profitTax(trader, tokensIn, q.grossQuote, q.quoteOut);
            q.profitTax = tax;
            q.quoteOut -= tax;
        }
    }

    // ───────────────────────────── trading ─────────────────────────────

    /// @inheritdoc IBondingCurve
    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        override
        returns (uint256 tokensOut)
    {
        (tokensOut,) = _buy(msg.sender, msg.sender, quoteIn, minTokensOut, deadline, false, type(uint256).max);
    }

    /// @notice Buy paying from msg.sender, tokens to `recipient` (all caps / cost basis apply to recipient).
    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline, address recipient)
        external
        returns (uint256 tokensOut)
    {
        if (recipient == address(0)) revert ZeroRecipient();
        (tokensOut,) = _buy(msg.sender, recipient, quoteIn, minTokensOut, deadline, false, type(uint256).max);
    }

    /// @notice Single-tx buy with an EIP-2612 permit on the quote token (STRATEGY and USDG support it).
    /// @dev Permit is wrapped in try/catch so a front-run permit does not brick the tx (allowance check follows).
    function buyWithPermit(
        uint256 quoteIn,
        uint256 minTokensOut,
        uint256 deadline,
        address recipient,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 tokensOut) {
        if (recipient == address(0)) revert ZeroRecipient();
        try IERC20Permit(quote).permit(msg.sender, address(this), quoteIn, permitDeadline, v, r, s) {} catch {}
        (tokensOut,) = _buy(msg.sender, recipient, quoteIn, minTokensOut, deadline, false, type(uint256).max);
    }

    /// @notice Same-tx creator buy from Launchpad: payer pulls quote, tokens go to `buyer`.
    ///         Exempt from anti-snipe (pays only 1% protocol fee + creator tax, which is 0 to self-net).
    ///         Mode caps apply to the creator like anyone (PVE: it is the only buy allowed in the launch block).
    function buyFor(address buyer, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        (tokensOut,) = _buy(msg.sender, buyer, quoteIn, minTokensOut, deadline, true, type(uint256).max);
    }

    /// @notice Trusted-router buy for `trader`. The router has ALREADY transferred `quoteIn` to this curve (prepaid:
    ///         no approve / transferFrom). Caps, login, cost basis and Trade attribution use `trader`; a graduation
    ///         refund goes back to the router (returned as `refund`). `maxImpactBps` is the router's impact cap (checked on the exact quote).
    function routerBuy(address trader, uint256 quoteIn, uint256 minTokensOut, uint256 deadline, uint256 maxImpactBps)
        external
        returns (uint256 tokensOut, uint256 refund)
    {
        _onlyRouter();
        if (trader == address(0)) revert ZeroRecipient();
        // audit L3: the prepaid quote must really be here, on top of the reserve and the PVE reward pool
        _prepaid(quote, quoteIn);
        return _buy(address(0), trader, quoteIn, minTokensOut, deadline, false, maxImpactBps);
    }

    /// @dev audit L3: a router's prepaid `amount` must be on top of what the curve already owes (quote: reserve +
    ///      PVE reward pool; token: unsold inventory).
    function _prepaid(address asset, uint256 amount) internal view {
        uint256 owed = asset == quote ? quoteReserve + rewardsHeld : Constants.TOTAL_SUPPLY - tokensSold;
        if (IERC20(asset).balanceOf(address(this)) < owed + amount) revert NotPrepaid();
    }

    function _onlyRouter() internal view {
        if (msg.sender == trustedRouter) {
            if (routerKilled) revert NotRouter();
        } else if (!ILaunchpadRouters(launchpad).isTrustedRouter(msg.sender)) {
            revert NotRouter();
        }
    }

    /// @notice Launchpad-only (owner = protocol multisig): stop / resume accepting the cached trusted router.
    function setRouterKilled(bool killed) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        routerKilled = killed;
    }

    /// @dev payer == address(0): quote was prepaid by a trusted router; refunds go to `trader`.
    function _buy(
        address payer,
        address trader,
        uint256 quoteIn,
        uint256 minTokensOut,
        uint256 deadline,
        bool snipeExempt,
        uint256 maxImpactBps
    ) internal returns (uint256 tokensOut, uint256 refund) {
        if (graduated) revert Graduated();
        if (block.timestamp > deadline) revert Expired();
        if (quoteIn == 0) revert ZeroAmount();

        if (payer != address(0)) IERC20(quote).safeTransferFrom(payer, address(this), quoteIn);

        uint256 sold = tokensSold;
        uint256 priceBefore = CurveMath.spotPriceWad(_params, sold);
        BuyQuote memory q = _quoteBuy(quoteIn, snipeExempt);
        if (q.impactBps > maxImpactBps) revert PriceImpactTooHigh(q.impactBps, maxImpactBps);
        refund = q.refund;
        if (refund > 0) {
            quoteIn -= refund; // effective spend for fees + Trade event
            // prepaid (router) → back to the router, which returns it to the trader in USDG (audit #6)
            IERC20(quote).safeTransfer(payer == address(0) ? msg.sender : payer, refund);
        }
        tokensOut = q.tokensOut;
        if (tokensOut < minTokensOut) revert Slippage();
        if (tokensOut == 0) revert ZeroAmount();

        uint256 newBal = _checkBuy(trader, tokensOut, snipeExempt, false);
        if (mode == Constants.MODE_PVE) _pveOnBuy(trader, newBal - tokensOut, newBal, quoteIn);
        balanceOnCurve[trader] = newBal;

        unchecked {
            tokensSold = sold + tokensOut; // <= sCurve
        }
        quoteReserve += q.quoteToCurve;

        IERC20(token).safeTransfer(trader, tokensOut);

        uint256 fees = q.fee + q.snipeFee;
        if (fees > 0) {
            // Gas: one transfer + one call for trade fee, creator tax and anti-snipe fee.
            uint256 protoFee = FeeMath.protocolFee(quoteIn - q.snipeFee);
            IERC20(quote).safeTransfer(address(feeRouter), fees);
            IFeeRouterCurve(address(feeRouter)).routeCurveFees(
                token, quote, trader, creator, protoFee, q.fee - protoFee, q.snipeFee
            );
        }

        emit Trade(
            token,
            trader,
            true,
            quoteIn,
            tokensOut,
            q.fee,
            q.snipeFee,
            priceBefore,
            q.priceAfterX18,
            q.impactBps,
            q.mcapAfterUsd
        );
        _emitAltitude(q.mcapAfterUsd);

        if (q.graduates) _graduate();
    }

    /// @dev Mode rules for a buy of `tokensOut` by `trader`; returns the new NET position. `isView` skips the
    ///      login-cache write (quotes). TRENCH: only the pre-existing walletCapBps (0 = none) — one immutable branch.
    function _checkBuy(address trader, uint256 tokensOut, bool launchBuy, bool isView)
        internal
        view
        returns (uint256 newBal)
    {
        newBal = balanceOnCurve[trader] + tokensOut;
        uint8 m = mode;
        if (m == Constants.MODE_TRENCH) {
            if (walletCapBps != 0 && newBal > FeeMath.walletCap(walletCapBps)) revert WalletCap();
            return newBal;
        }
        if (m == Constants.MODE_PVE) {
            if (!launchBuy && block.number == launchBlock) revert LaunchBlock();
            if (isView) {
                if (_acct[trader].verifiedUntil <= block.timestamp && _gateUntil(trader) <= block.timestamp) {
                    revert NotVerified();
                }
            }
        }
        if (tokensOut > maxBuyNow()) revert BuyTooLarge();
        if (newBal > netCapNow()) revert WalletCap();
    }

    function _gateUntil(address trader) internal view returns (uint64) {
        return ILoginGate(loginGate).verifiedUntil(trader, token);
    }

    /// @dev PVE buy bookkeeping: login check (cached), reward settlement at the CURRENT accumulator (so a new
    ///      buyer's rewardDebt starts at acc and earns nothing from earlier taxed sells), cost basis, totalNet.
    function _pveOnBuy(address trader, uint256 oldBal, uint256 newBal, uint256 quoteSpent) internal {
        Acct memory a = _acct[trader];
        if (a.verifiedUntil <= block.timestamp) {
            uint64 u = _gateUntil(trader);
            if (u <= block.timestamp) revert NotVerified();
            // audit L1: cache at most PVE_LOGIN_CACHE_TTL so a LoginGate revoke bites within 10 minutes
            uint256 capT = block.timestamp + Constants.PVE_LOGIN_CACHE_TTL;
            a.verifiedUntil = u > capT ? uint64(capT) : u;
        }
        uint256 acc = accRewardPerToken;
        if (acc != 0) {
            if (oldBal != 0) rewardsAccrued[trader] += Math.mulDiv(oldBal, acc, ACC_SCALE) - rewardDebt[trader];
            rewardDebt[trader] = Math.mulDiv(newBal, acc, ACC_SCALE);
        }
        a.cost += uint128(quoteSpent);
        _acct[trader] = a;
        totalNet += newBal - oldBal;
    }

    /// @dev Profit tax for selling `tokensIn` with `grossQuote` proceeds (before fees) / `netOut` (after fees).
    ///      Cost basis of the sold tokens = cost * tokensIn / NET (tokens beyond the NET position, i.e. received by
    ///      transfer, carry zero basis). Taxed iff grossQuote > 1.77 × basis ⇔ exit price > avg cost × 1.77.
    function _profitTax(address seller, uint256 tokensIn, uint256 grossQuote, uint256 netOut)
        internal
        view
        returns (uint256 tax, uint256 costPortion)
    {
        uint256 net = balanceOnCurve[seller];
        uint256 cost = _acct[seller].cost;
        costPortion = tokensIn >= net ? cost : Math.mulDiv(cost, tokensIn, net);
        if (grossQuote * Constants.BPS_DENOM > costPortion * Constants.PVE_PROFIT_TRIGGER_BPS) {
            tax = (netOut * Constants.PVE_PROFIT_TAX_PPM) / 1e6;
        }
    }

    /// @inheritdoc IBondingCurve
    function sell(uint256 tokensIn, uint256 minQuoteOut, uint256 deadline)
        external
        override
        returns (uint256 quoteOut)
    {
        return _sell(msg.sender, msg.sender, tokensIn, minQuoteOut, deadline, true, type(uint256).max);
    }

    /// @notice Sell msg.sender's tokens, net quote to `recipient`.
    function sell(uint256 tokensIn, uint256 minQuoteOut, uint256 deadline, address recipient)
        external
        returns (uint256 quoteOut)
    {
        if (recipient == address(0)) revert ZeroRecipient();
        return _sell(msg.sender, recipient, tokensIn, minQuoteOut, deadline, true, type(uint256).max);
    }

    /// @notice Single-tx sell with an EIP-2612 permit on the launch token (all DISCIPLE tokens support it).
    function sellWithPermit(
        uint256 tokensIn,
        uint256 minQuoteOut,
        uint256 deadline,
        address recipient,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 quoteOut) {
        if (recipient == address(0)) revert ZeroRecipient();
        try IERC20Permit(token).permit(msg.sender, address(this), tokensIn, permitDeadline, v, r, s) {} catch {}
        return _sell(msg.sender, recipient, tokensIn, minQuoteOut, deadline, true, type(uint256).max);
    }

    /// @notice Trusted-router sell for `trader`: the router has ALREADY transferred `tokensIn` (from the trader) to
    ///         this curve. NET position, cost basis, profit tax and fee attribution use `trader` (not the router).
    function routerSell(
        address trader,
        uint256 tokensIn,
        uint256 minQuoteOut,
        uint256 deadline,
        address recipient,
        uint256 maxImpactBps
    ) external returns (uint256 quoteOut) {
        _onlyRouter();
        if (recipient == address(0) || trader == address(0)) revert ZeroRecipient();
        // audit L3: the prepaid tokens must really be here, on top of the unsold curve inventory
        _prepaid(token, tokensIn);
        return _sell(trader, recipient, tokensIn, minQuoteOut, deadline, false, maxImpactBps);
    }

    function _sell(
        address trader,
        address recipient,
        uint256 tokensIn,
        uint256 minQuoteOut,
        uint256 deadline,
        bool pull,
        uint256 maxImpactBps
    ) internal returns (uint256 quoteOut) {
        if (graduated) revert Graduated();
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();

        if (pull) IERC20(token).safeTransferFrom(trader, address(this), tokensIn);

        uint256 sold = tokensSold;
        uint256 priceBefore = CurveMath.spotPriceWad(_params, sold);
        SellQuote memory q = quoteSell(tokensIn);
        if (q.impactBps > maxImpactBps) revert PriceImpactTooHigh(q.impactBps, maxImpactBps);
        quoteOut = q.quoteOut;

        uint256 bal = balanceOnCurve[trader];
        uint256 newBal = bal < tokensIn ? 0 : bal - tokensIn;
        if (mode == Constants.MODE_PVE) {
            if (tokensIn > FeeMath.walletCap(Constants.PVE_MAX_SELL_BPS)) revert SellTooLarge();
            quoteOut -= _pveOnSell(trader, tokensIn, bal, newBal, q.grossQuote, quoteOut);
        }
        if (quoteOut < minQuoteOut) revert Slippage();
        if (bal != newBal) balanceOnCurve[trader] = newBal;

        tokensSold = sold - tokensIn;
        quoteReserve -= q.grossQuote;

        if (q.fee > 0) {
            uint256 protoFee = FeeMath.protocolFee(q.grossQuote);
            IERC20(quote).safeTransfer(address(feeRouter), q.fee);
            feeRouter.routeTradeFee(token, quote, trader, creator, protoFee, q.fee - protoFee);
        }

        IERC20(quote).safeTransfer(recipient, quoteOut);
        emit Trade(
            token,
            trader,
            false,
            quoteOut,
            tokensIn,
            q.fee,
            0,
            priceBefore,
            q.priceAfterX18,
            q.impactBps,
            q.mcapAfterUsd
        );
        _emitAltitude(q.mcapAfterUsd);
    }

    /// @dev PVE sell bookkeeping. Ordering (fairness): (1) settle the seller at the OLD accumulator, (2) shrink their
    ///      NET position + totalNet, (3) distribute the tax over everyone else's NET (totalNet - seller's remaining
    ///      NET), (4) reset the seller's rewardDebt at the NEW accumulator — so the seller gets 0 of their own tax and
    ///      each other holder gets tax × theirNet / othersNet. The tax stays in this contract (outside quoteReserve).
    function _pveOnSell(address seller, uint256 tokensIn, uint256 bal, uint256 newBal, uint256 gross, uint256 netOut)
        internal
        returns (uint256 tax)
    {
        uint256 costPortion;
        (tax, costPortion) = _profitTax(seller, tokensIn, gross, netOut);
        uint256 acc = accRewardPerToken;
        if (acc != 0 && bal != 0) rewardsAccrued[seller] += Math.mulDiv(bal, acc, ACC_SCALE) - rewardDebt[seller];
        if (costPortion != 0) _acct[seller].cost -= uint128(costPortion);
        uint256 tn = totalNet - (bal - newBal);
        totalNet = tn;
        if (tax != 0) {
            acc = _distributeTax(tax, tn - newBal, acc);
            emit ProfitTaxCharged(token, seller, tax, gross, costPortion);
        }
        if (acc != 0) rewardDebt[seller] = Math.mulDiv(newBal, acc, ACC_SCALE);
    }

    /// @dev Tax over everyone else's NET (`others`); audit L6: nobody else holds → treasury now (not to whoever
    ///      buys in later). Returns the new accumulator.
    function _distributeTax(uint256 tax, uint256 others, uint256 acc) internal returns (uint256) {
        if (others == 0) {
            IERC20(quote).safeTransfer(address(feeRouter), tax);
            IFeeRouterCurve(address(feeRouter)).accrueTreasury(quote, tax);
            return acc;
        }
        acc += Math.mulDiv(tax, ACC_SCALE, others);
        accRewardPerToken = acc;
        rewardsHeld += tax;
        return acc;
    }

    // ── PVE: NET positions follow transfers (DISCIPLE audit Medium-1) ──

    /// @notice Called by the PVE token on pre-graduation wallet→wallet transfers (never for transfers to/from this
    ///         curve). Moves min(amount, sender NET) of NET position, the cost basis pro rata, and settles both
    ///         sides' rewards at the current accumulator first. The receiver's 1% NET cap applies. Transfers
    ///         involving the snapshotted router are not booked (it never holds tokens between calls).
    function onTokenTransfer(address from, address to, uint256 amount) external {
        if (msg.sender != token) revert OnlyToken();
        // audit round-3 HIGH: a self-transfer must be a no-op (it would settle the same slot twice and add `moved`
        // back onto the same NET key)
        if (graduated || from == to || amount == 0) return;
        address r = trustedRouter;
        if (from == r || to == r) return;
        uint256 fb = balanceOnCurve[from];
        uint256 moved = amount < fb ? amount : fb;
        if (moved == 0) return; // tokens beyond the NET position carry no NET / basis
        uint256 tb = balanceOnCurve[to];
        uint256 newFrom = fb - moved;
        uint256 newTo = tb + moved;
        if (newTo > netCapNow()) revert WalletCap();
        uint256 acc = accRewardPerToken;
        if (acc != 0) {
            rewardsAccrued[from] += Math.mulDiv(fb, acc, ACC_SCALE) - rewardDebt[from];
            if (tb != 0) rewardsAccrued[to] += Math.mulDiv(tb, acc, ACC_SCALE) - rewardDebt[to];
            rewardDebt[from] = Math.mulDiv(newFrom, acc, ACC_SCALE);
            rewardDebt[to] = Math.mulDiv(newTo, acc, ACC_SCALE);
        }
        uint128 cf = _acct[from].cost;
        uint128 cm = moved == fb ? cf : uint128(Math.mulDiv(cf, moved, fb));
        if (cm != 0) {
            _acct[from].cost = cf - cm;
            _acct[to].cost += cm;
        }
        balanceOnCurve[from] = newFrom;
        balanceOnCurve[to] = newTo;
    }

    // ── PVE holder rewards ──

    /// @notice Claim your PVE profit-tax rewards (quote). Works before and after graduation (the pool and the NET
    ///         positions are frozen at graduation, so the claimable amount never changes afterwards).
    function claim() external returns (uint256) {
        return _claim(msg.sender);
    }

    /// @notice Launchpad.claim(token) entry point.
    function claimFor(address holder) external returns (uint256) {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        return _claim(holder);
    }

    function _claim(address holder) internal returns (uint256 amount) {
        amount = pendingRewards(holder);
        if (amount == 0) revert ZeroAmount();
        rewardsAccrued[holder] = 0;
        rewardDebt[holder] = Math.mulDiv(balanceOnCurve[holder], accRewardPerToken, ACC_SCALE);
        uint256 held = rewardsHeld;
        rewardsHeld = held > amount ? held - amount : 0;
        IERC20(quote).safeTransfer(holder, amount);
        emit HolderRewardsClaimed(token, holder, amount);
    }

    // ── altitude (spot) ──

    function _emitAltitude(uint256 mcap) internal {
        uint8 tier = Altitude.tierOf(mcap);
        emit AltitudeUpdate(token, mcap, tier);
        uint8 prev = altitudeTier;
        if (tier != prev) {
            altitudeTier = tier;
            emit TierBreak(token, prev, tier, mcap);
        }
    }

    /// @dev Atomic same-tx migrate to locked v4 at curve-end price — no pause/gap (§2 / LOCKED #5).
    function _graduate() internal {
        if (graduated) return;
        graduated = true;

        uint256 tokenLiq = IERC20(token).balanceOf(address(this));
        uint256 quoteLiq = quoteReserve;
        uint256 y = _params.y0 - tokensSold;
        uint256 x = CurveMath.virtualQuote(_params, tokensSold);
        uint160 sqrtPriceX96 = SqrtPrice.fromReserves(x, y, uint160(token) < uint160(quote));

        IERC20(token).forceApprove(address(migration), tokenLiq);
        IERC20(quote).forceApprove(address(migration), quoteLiq);

        bytes32 poolId = migration.migrate(token, quote, tokenLiq, quoteLiq, sqrtPriceX96);
        quoteReserve = 0;

        // PVE: holder rewards stay here, claimable forever; NET positions freeze (token stops notifying).
        if (mode == Constants.MODE_PVE) IPveToken(token).endPveHooks();

        emit GraduatedToV4(token, poolId, tokenLiq, quoteLiq);
    }
}

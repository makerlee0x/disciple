// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Constants} from "../libraries/Constants.sol";
import {McapMath} from "../libraries/McapMath.sol";

interface ILensLaunchpad {
    function curveOf(address token) external view returns (address);
    function pricer() external view returns (address);
}

interface ILensCurve {
    function quote() external view returns (address);
    function graduated() external view returns (bool);
    function priceNow() external view returns (uint256);
    function quotePriceUsd() external view returns (uint256);
    function mcapNow() external view returns (uint256);
}

/// @dev Mode rules v2 curve surface.
interface ILensCurveV2 {
    struct SellQuote {
        uint256 quoteOut;
        uint256 fee;
        uint256 grossQuote;
        uint256 priceAfterX18;
        uint256 impactBps;
        uint256 mcapAfterUsd;
        uint256 profitTax;
    }

    function mode() external view returns (uint8);
    function token() external view returns (address);
    function launchTime() external view returns (uint256);
    function netCapNow() external view returns (uint256);
    function capRoom(address wallet) external view returns (uint256);
    function currentSnipeFeeBps() external view returns (uint256);
    function snipeEscrow() external view returns (uint256);
    function crewTipThresholdBps() external view returns (uint256);
    function marketCapQuote() external view returns (uint256);
    function costBasisOf(address wallet) external view returns (uint256);
    function balanceOnCurve(address wallet) external view returns (uint256);
    function quoteSellFor(address trader, uint256 tokensIn) external view returns (SellQuote memory);
}

interface ILensToken {
    function creator() external view returns (address);
    function creatorLocked() external view returns (uint88);
    function pveLive() external view returns (bool);
}

interface ILensMigration {
    function poolIdOf(address token) external view returns (bytes32);
    function poolManager() external view returns (IPoolManager);
}

interface ILensPricer {
    function quotePriceUsd(address quote) external view returns (uint256);
}

/// @title Read-only market lens (add-on; no core redeploy)
/// @notice Correct live price/mcap for ALL coins, incl. ones whose already-deployed curve returns the frozen
///         curve-end mcap after graduation. Post-grad: v4 pool slot0 x live QuotePricer.
contract MarketLens {
    ILensLaunchpad public immutable launchpad;
    ILensMigration public immutable migration;

    constructor(address launchpad_, address migration_) {
        launchpad = ILensLaunchpad(launchpad_);
        migration = ILensMigration(migration_);
    }

    /// @return priceWad quote raw * 1e18 / token raw
    /// @return mcapUsd USD WAD
    /// @return graduated whether the price came from the v4 pool
    function market(address token) public view returns (uint256 priceWad, uint256 mcapUsd, bool graduated) {
        ILensCurve c = ILensCurve(launchpad.curveOf(token));
        address q = c.quote();
        graduated = c.graduated();
        uint256 qUsd = c.quotePriceUsd();
        if (graduated) {
            (uint160 sp,,,) = StateLibrary.getSlot0(migration.poolManager(), PoolId.wrap(migration.poolIdOf(token)));
            priceWad = uint160(token) < uint160(q)
                ? Math.mulDiv(Math.mulDiv(sp, sp, 1 << 64), 1e18, 1 << 128)
                : Math.mulDiv(Math.mulDiv(1e18, 1 << 96, sp), 1 << 96, sp);
            address p = launchpad.pricer();
            if (p != address(0)) {
                try ILensPricer(p).quotePriceUsd(q) returns (uint256 v) {
                    if (v > 0) qUsd = v;
                } catch {}
            }
            // full precision from sqrtPrice (a floored priceWad under-reports 6-dec quotes by up to ~15%)
            mcapUsd = McapMath.mcapUsdFromSqrt(sp, uint160(token) < uint160(q), Constants.TOTAL_SUPPLY, qUsd);
        } else {
            priceWad = c.priceNow();
            mcapUsd = c.mcapNow(); // the curve's own value (full precision on current curves)
        }
    }

    function mcapNow(address token) external view returns (uint256 m) {
        (, m,) = market(token);
    }

    // ───────────────────────── mode rules v2 views ─────────────────────────

    function _v2(address token) internal view returns (ILensCurveV2) {
        return ILensCurveV2(launchpad.curveOf(token));
    }

    /// @notice Tokens `wallet` can still buy on the curve now (holding-cap room ∧ unsold supply; 0 after graduation).
    ///         Buy presets should be limited to this: anything above partially fills and refunds the rest.
    function capRoom(address token, address wallet) external view returns (uint256) {
        return _v2(token).capRoom(wallet);
    }

    /// @notice Current holding cap: `capBps` (bps of supply, floored; 0 = no cap) and `capTokens` (token wei,
    ///         type(uint256).max = none). Easy 1%→3.33%, Hard 3.33%→7.77% linear in mcap $7K→$33K.
    function capNow(address token) external view returns (uint256 capBps, uint256 capTokens) {
        ILensCurveV2 c = _v2(token);
        if (ILensCurve(address(c)).graduated()) return (0, type(uint256).max);
        capTokens = c.netCapNow();
        if (capTokens != type(uint256).max) capBps = (capTokens * Constants.BPS_DENOM) / Constants.TOTAL_SUPPLY;
    }

    /// @notice Sniper tax right now (bps of a buy's input) and seconds until it reaches 0 (99% → 0 over 60s).
    function sniperTax(address token) external view returns (uint256 bps, uint256 secondsLeft) {
        ILensCurveV2 c = _v2(token);
        if (ILensCurve(address(c)).graduated()) return (0, 0);
        bps = c.currentSnipeFeeBps();
        uint256 end = c.launchTime() + Constants.ANTI_SNIPE_DURATION;
        if (block.timestamp < end) secondsLeft = end - block.timestamp;
    }

    /// @notice Sniper escrow: `amount` held, `releasableAt` (launch + 30 days; anyone may then send it to RewardsVault
    ///         if the coin has not graduated), `releasable` now.
    function snipeEscrow(address token) external view returns (uint256 amount, uint256 releasableAt, bool releasable) {
        ILensCurveV2 c = _v2(token);
        amount = c.snipeEscrow();
        releasableAt = c.launchTime() + Constants.SNIPE_ESCROW_TIMEOUT;
        releasable = amount != 0 && !ILensCurve(address(c)).graduated() && block.timestamp >= releasableAt;
    }

    /// @notice Easy creator lock: `creator` (original launcher), `locked` First BOOST amount, `unlocked` = the lock no
    ///         longer applies (graduated / not an Easy coin / no First BOOST).
    function creatorLock(address token) external view returns (address creator, uint256 locked, bool unlocked) {
        ILensCurveV2 c = _v2(token);
        creator = ILensToken(token).creator();
        if (c.mode() != Constants.MODE_PVE) return (creator, 0, true);
        locked = ILensToken(token).creatorLocked();
        unlocked = locked == 0 || !ILensToken(token).pveLive();
    }

    /// @notice Easy crew-tip estimate for `seller` selling `tokensIn` now: `tip` (pair coin, already deducted from
    ///         `quoteOut`), realized `profit` (net proceeds − cost of the sold part, 0 if a loss) and the `threshold`
    ///         it must exceed (crewTipThresholdBps × current mcap, pair coin). 0s for non-Easy / graduated coins.
    function crewTipEstimate(address token, address seller, uint256 tokensIn)
        external
        view
        returns (uint256 tip, uint256 quoteOut, uint256 profit, uint256 threshold)
    {
        ILensCurveV2 c = _v2(token);
        if (c.mode() != Constants.MODE_PVE || ILensCurve(address(c)).graduated()) return (0, 0, 0, 0);
        ILensCurveV2.SellQuote memory q = c.quoteSellFor(seller, tokensIn);
        tip = q.profitTax;
        quoteOut = q.quoteOut;
        uint256 net = c.balanceOnCurve(seller);
        uint256 cost = c.costBasisOf(seller);
        uint256 costPortion = tokensIn >= net ? cost : Math.mulDiv(cost, tokensIn, net);
        uint256 proceeds = q.quoteOut + tip;
        if (proceeds > costPortion) profit = proceeds - costPortion;
        threshold = Math.mulDiv(c.marketCapQuote(), c.crewTipThresholdBps(), Constants.BPS_DENOM);
    }
}

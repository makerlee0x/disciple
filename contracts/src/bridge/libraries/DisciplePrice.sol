// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FixedPointMathLib as FPM} from "./vendor/FixedPointMathLib.sol";

/// @title Disciple cross-chain price lifecycle (pure rules)
/// @notice The rules a cross-chain Disciple pool applies to its LayerZero anchor. Same-chain pools do not use this
///         library: they latch the anchor per block and read the live source boundary (DiscipleSwapMath).
///
///         The pool never stops trading. Its quote moves through three stages as the anchor ages:
///
///         1. Fresh (age < GRACE). The base spread h0 = -ln(1 - fee). A keeper refreshes on a 1% home move and
///            sends a heartbeat at HEARTBEAT, so a working keeper never lets a price reach GRACE.
///         2. Late (GRACE <= age < LOCAL_AFTER). The log half-spread widens continuously:
///                h(age) = sqrt(h0^2 + (Z * SIGMA)^2 * (age - GRACE) / YEAR)
///            and the oracle band (ask >= A*G, bid <= A/G) stays on.
///         3. Local (age >= LOCAL_AFTER). The feed is treated as down. On entry the pool re-centres its seed ratio
///            T to the current reserves (so the curve mid equals the frozen anchor), drops the band, and fades the
///            spread from h(LOCAL_AFTER) back to h0 over FADE. Trading continues on the curve, so local flow moves
///            the price.
///
///         A fresh observation ends local mode only if it passes `recoveryOk`; the pool then re-centres T again and
///         restores the band. Prices and the anchor are X128 (raw quote per raw coin * 2^128); spreads and markups
///         are WAD. All rounding widens the spread (against the trader).
///
///         Design record: disciple-sim/v0/followup/OUTAGE.md, OUTAGE2.md and entry_check.log (2026-11-04).
library DisciplePrice {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant FEE_DENOM = 1e6;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    /// @dev One fixed volatility tier for every cross-chain pool (maker, 2026-11-04): 120% a year.
    uint256 internal constant SIGMA = 1.2e18;
    /// @dev 95% band multiplier.
    uint256 internal constant Z = 1.96e18;
    /// @dev No widening while a working keeper would have refreshed.
    uint256 internal constant GRACE = 60 minutes;
    /// @dev Keeper heartbeat, sent early enough that the price lands before GRACE.
    uint256 internal constant HEARTBEAT = 3570; // 59.5 minutes
    /// @dev A request sent at this age or later is paid as a heartbeat.
    uint256 internal constant HEARTBEAT_PAID_AFTER = 59 minutes;
    /// @dev Refresh trigger and paid-update test: a home move of at least 1%.
    uint256 internal constant MOVE_BPS = 100;
    /// @dev Age at which the pool treats the feed as down and switches to local mode.
    uint256 internal constant LOCAL_AFTER = 2 hours;
    /// @dev Local mode fades the spread back to base over this long.
    uint256 internal constant FADE = 30 minutes;
    /// @dev A recovery observation must be at most this old when it lands.
    uint256 internal constant MAX_RECOVERY_AGE = 120;
    /// @dev Keepers are refunded the LayerZero fee plus 20% (maker, 2026-11-04).
    uint256 internal constant REFUND_BPS = 12_000;

    /// @dev (Z * SIGMA)^2 in WAD^2 = 2.352^2 * 1e36.
    uint256 internal constant ZS_SQ = 5_531_904e30;
    /// @dev Matches DiscipleSwapMath: added against the trader to cover Solady's lnWad/expWad error.
    uint256 internal constant LN_SLACK = 1000;
    uint256 internal constant EXP_SLACK = 2;

    error BadParams();

    enum Stage {
        Fresh,
        Late,
        Local
    }

    // ---------------------------------------------------------------------------------------------
    // Spread
    // ---------------------------------------------------------------------------------------------

    /// @notice h0 = -ln(1 - fee) = ln(1e6 / (1e6 - fee)), WAD, rounded up. exp(h0) is the same-chain markup
    ///         1 / (1 - f), so a fresh cross-chain quote charges exactly the pool fee.
    function baseLog(uint256 feePips) internal pure returns (uint256) {
        if (feePips == 0) return 0;
        if (feePips >= FEE_DENOM) revert BadParams();
        uint256 ratio = Math.mulDiv(FEE_DENOM, WAD, FEE_DENOM - feePips, Math.Rounding.Ceil);
        int256 ln = FPM.lnWad(int256(ratio));
        return (ln > 0 ? uint256(ln) : 0) + LN_SLACK;
    }

    /// @notice The stage for an anchor of the given age (seconds since the SOURCE observation).
    function stage(uint256 age) internal pure returns (Stage) {
        if (age < GRACE) return Stage.Fresh;
        if (age < LOCAL_AFTER) return Stage.Late;
        return Stage.Local;
    }

    /// @notice Log half-spread for the Fresh and Late stages: sqrt(h0^2 + (Z*SIGMA)^2 * max(age - GRACE, 0) / YEAR),
    ///         WAD, rounded up. Continuous at GRACE (no jump when widening starts).
    function widenLog(uint256 h0, uint256 age) internal pure returns (uint256) {
        if (age <= GRACE) return h0;
        uint256 x = age - GRACE;
        uint256 var_ = h0 * h0 + Math.mulDiv(ZS_SQ, x, YEAR, Math.Rounding.Ceil);
        return _sqrtUp(var_);
    }

    /// @notice Log half-spread for any age, including the local-mode fade from h(LOCAL_AFTER) to h0 over FADE.
    function spreadLog(uint256 h0, uint256 age) internal pure returns (uint256) {
        if (age < LOCAL_AFTER) return widenLog(h0, age);
        uint256 hCap = widenLog(h0, LOCAL_AFTER);
        uint256 w = age - LOCAL_AFTER;
        if (w >= FADE) return h0;
        // hCap - (hCap - h0) * w / FADE, with the subtracted part rounded down (spread rounded up)
        return hCap - Math.mulDiv(hCap - h0, w, FADE);
    }

    /// @notice Markup G = exp(h), WAD, rounded up. Feed it to DiscipleSwapMath.slopes as `g`.
    function markupFromLog(uint256 h) internal pure returns (uint256) {
        if (h == 0) return WAD;
        if (h >= 135e18) revert BadParams();
        uint256 e = uint256(FPM.expWad(int256(h)));
        return e + e / 1e17 + EXP_SLACK;
    }

    /// @notice One call for the swap path: the markup G and whether the oracle band applies.
    function markup(uint256 feePips, uint256 age) internal pure returns (uint256 g, bool bandOn) {
        uint256 h0 = baseLog(feePips);
        g = markupFromLog(spreadLog(h0, age));
        bandOn = age < LOCAL_AFTER;
    }

    /// @notice Oracle band around the anchor: ask floor A*G rounded up, bid ceiling A/G rounded down. Zero (no
    ///         boundary) in local mode. Pass as `p` to the DiscipleSwapMath fills.
    function band(uint256 anchorX128, uint256 g, bool bandOn) internal pure returns (uint256 askFloor, uint256 bidCeil) {
        if (!bandOn) return (0, 0);
        askFloor = Math.mulDiv(anchorX128, g, WAD, Math.Rounding.Ceil);
        bidCeil = Math.mulDiv(anchorX128, WAD, g);
    }

    // ---------------------------------------------------------------------------------------------
    // Re-centring, recovery, keeper refunds
    // ---------------------------------------------------------------------------------------------

    /// @notice The seed ratio that puts the curve mid (A/T) * (v/u) at the anchor for these reserves: T = v/u, X128.
    ///         Applied on entry to local mode and again on recovery (design B4R).
    function recentre(uint256 coinReserve, uint256 quoteReserve) internal pure returns (uint256 tX128) {
        if (coinReserve == 0 || quoteReserve == 0) revert BadParams();
        tX128 = Math.mulDiv(quoteReserve, Q128, coinReserve);
        if (tX128 == 0) revert BadParams();
    }

    /// @notice Whether an observation may end local mode. It must be newer than the last accepted one, taken after
    ///         local mode began, not from the future, and at most MAX_RECOVERY_AGE old on arrival. A failed check
    ///         leaves the pool trading in local mode.
    function recoveryOk(uint256 observedAt, uint256 lastObservedAt, uint256 nowTs) internal pure returns (bool) {
        if (observedAt <= lastObservedAt || observedAt > nowTs) return false;
        if (observedAt < lastObservedAt + LOCAL_AFTER) return false;
        return nowTs - observedAt <= MAX_RECOVERY_AGE;
    }

    /// @notice Whether an observation may replace the anchor outside local mode: strictly newer and not from the
    ///         future. Its age then sets the spread, so an old-but-newer observation only widens the quote.
    function updateOk(uint256 observedAt, uint256 lastObservedAt, uint256 nowTs) internal pure returns (bool) {
        return observedAt > lastObservedAt && observedAt <= nowTs;
    }

    /// @notice Keeper refund for an accepted update: lzFee * 1.2 if the delivered price moved at least MOVE_BPS from
    ///         the anchor it replaced, or the request was sent as a heartbeat (anchor age >= HEARTBEAT_PAID_AFTER).
    ///         Otherwise 0, so pointless requests are paid by whoever sent them.
    function refund(uint256 oldAnchor, uint256 newAnchor, uint256 ageAtRequest, uint256 lzFee)
        internal
        pure
        returns (uint256)
    {
        if (ageAtRequest >= HEARTBEAT_PAID_AFTER || _moved(oldAnchor, newAnchor)) {
            return Math.mulDiv(lzFee, REFUND_BPS, BPS);
        }
        return 0;
    }

    /// @notice Whether a keeper should send a request now (off-chain helper and on-chain view).
    function refreshDue(uint256 anchor, uint256 homePrice, uint256 age) internal pure returns (bool) {
        return age >= HEARTBEAT || _moved(anchor, homePrice);
    }

    function _moved(uint256 ref, uint256 price) private pure returns (bool) {
        if (ref == 0) return true;
        uint256 d = price > ref ? price - ref : ref - price;
        return Math.mulDiv(d, BPS, ref) >= MOVE_BPS;
    }

    function _sqrtUp(uint256 x) private pure returns (uint256 z) {
        z = FPM.sqrt(x);
        if (z * z < x) z += 1;
    }
}

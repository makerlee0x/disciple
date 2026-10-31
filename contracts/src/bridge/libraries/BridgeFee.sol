// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";

/// @title Fee, boost, and smoothing helpers for Disciple
/// @notice The swap fee is only the progress slide: 2% while the pool is tiny, 0.3% once pool TVL
///         reaches the live graduation target. It does not rise with the price gap, with volume,
///         or because the anchor is stale. The gap is the incentive. Fees are denominated in USDG
///         and the same bps applies to buys, sells, and redeems.
library BridgeFee {
    /// @notice 2% at TVL 0, sliding to 0.3% as `tvl` approaches `gradTvl`. Unknown graduation stays at 2%.
    ///         This is the fee a swap pays. `gradTvl` is 12% of the smoothed reference TVL. If that
    ///         target later rises above `tvl`, the fee steps back up the same line.
    function baseFeeBps(uint256 tvl, uint256 gradTvl) internal pure returns (uint256) {
        if (gradTvl == 0 || tvl >= gradTvl) {
            return gradTvl == 0 ? C.FEE_TINY_BPS : C.FEE_GRAD_BPS;
        }
        return C.FEE_GRAD_BPS + ((C.FEE_TINY_BPS - C.FEE_GRAD_BPS) * (gradTvl - tvl)) / gradTvl;
    }

    /// @notice `amount * 2^(-dt/halfLife)`. Integer halvings shift; the fraction uses exp(-x ln 2).
    ///         `halfLife == 0` or `dt == 0` leaves the amount unchanged. At least 64 half-lives forgets it.
    ///         Rounds down. Used to smooth reference TVL. It is not a fee.
    function decayed(uint256 amount, uint256 dt, uint256 halfLife) internal pure returns (uint256) {
        if (amount == 0 || halfLife == 0 || dt == 0) return amount;
        uint256 halves = dt / halfLife;
        if (halves >= 64) return 0;
        uint256 v = amount >> halves;
        uint256 frac = dt % halfLife;
        if (frac == 0 || v == 0) return v;
        uint256 z = Math.mulDiv(frac, C.LN2_WAD, halfLife);
        return Math.mulDiv(v, _expNeg(z), C.WAD);
    }

    /// @notice 5x at TVL 0, linear to 1.2x at `gradTvl`. Unknown graduation stays at 5x.
    ///         While pool TVL is at or above the live target the weight stays 1.2x. A higher target
    ///         puts it back on the line. Fee weight only. Never applied to principal.
    function boostWad(uint256 tvl, uint256 gradTvl) internal pure returns (uint256) {
        if (gradTvl == 0 || tvl >= gradTvl) {
            return gradTvl == 0 ? C.BOOST_START_WAD : C.BOOST_END_WAD;
        }
        return C.BOOST_END_WAD + ((C.BOOST_START_WAD - C.BOOST_END_WAD) * (gradTvl - tvl)) / gradTvl;
    }

    /// @notice Safety cap on one Dutch slice, then scaled by progress toward the live target.
    ///         The safety cap is `min($50, max(TVL/20, $1))`. Progress `poolTVL / gradTvl` multiplies
    ///         it from 100% at a new pool down to `DUTCH_PROGRESS_FLOOR_WAD` (20%) at the target.
    ///         `gradTvl == 0` does not scale down. A larger reference lowers progress and reopens the cap.
    function dutchCap(uint256 tvl, uint256 gradTvl) internal pure returns (uint256 cap) {
        cap = tvl / 20;
        if (cap < C.DUTCH_MIN_SLICE) cap = C.DUTCH_MIN_SLICE;
        if (cap > C.DUTCH_MAX_SLICE) cap = C.DUTCH_MAX_SLICE;
        if (gradTvl == 0 || tvl == 0) return cap;
        uint256 progress = tvl >= gradTvl ? C.WAD : Math.mulDiv(tvl, C.WAD, gradTvl);
        uint256 keep = C.WAD - Math.mulDiv(progress, C.WAD - C.DUTCH_PROGRESS_FLOOR_WAD, C.WAD);
        cap = Math.mulDiv(cap, keep, C.WAD);
        if (cap == 0) cap = 1;
    }

    /// @notice max($500, 5% of TVL). Kept liquid so a vault outage does not stop ordinary sells.
    function buffer(uint256 tvl) internal pure returns (uint256) {
        uint256 pct = (tvl * C.BUFFER_TVL_BPS) / C.BPS;
        return pct > C.BUFFER_MIN ? pct : C.BUFFER_MIN;
    }

    /// @dev exp(-z) for z in WAD, z < ln(2). Twelve terms. If a term would underflow the sum, stop
    ///      and keep the larger sum (less decay).
    function _expNeg(uint256 z) private pure returns (uint256) {
        uint256 sum = C.WAD;
        uint256 term = C.WAD;
        for (uint256 i = 1; i <= 12; ++i) {
            term = Math.mulDiv(term, z, C.WAD * i);
            if (term == 0) break;
            if (i % 2 == 1) {
                if (term >= sum) break;
                sum -= term;
            } else {
                sum += term;
            }
        }
        return sum;
    }
}

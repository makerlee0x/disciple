// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";

/// @title Fee, staleness, boost, and rev-fee helpers for Disciple
/// @notice Fees are denominated in USDG on both buys and sells. The same bps applies in either
///         direction. Recent volume revs the fee from a 0.3% floor up to the TVL-based cap.
///         Nothing here discounts a bridge, a gap-closing trade, or a wash.
library BridgeFee {
    /// @notice 2% at TVL 0, sliding to 0.3% as `tvl` approaches `gradTvl`. Unknown graduation stays at 2%.
    ///         This is the hot ceiling of the rev fee, not the fee a quiet pool pays.
    function baseFeeBps(uint256 tvl, uint256 gradTvl) internal pure returns (uint256) {
        if (gradTvl == 0 || tvl >= gradTvl) {
            return gradTvl == 0 ? C.FEE_TINY_BPS : C.FEE_GRAD_BPS;
        }
        return C.FEE_GRAD_BPS + ((C.FEE_TINY_BPS - C.FEE_GRAD_BPS) * (gradTvl - tvl)) / gradTvl;
    }

    /// @notice Floor when recent volume is ~0, the growth cap once volume reaches `redLineWad` of `tvlRef`.
    ///         `volume` already includes this trade. `redLineWad == 0` returns the cap only, so a caller
    ///         that has not turned the rev fee on keeps the sliding 2%→0.3% schedule.
    /// @dev Monotone in `volume`. A larger denominator lowers the fee; callers pass the block-open TVL
    ///      when it is smaller than the current TVL, so a same-block deposit cannot cheapen the clip.
    function revBps(uint256 tvl, uint256 gradTvl, uint256 volume, uint256 redLineWad, uint256 tvlRef)
        internal
        pure
        returns (uint256)
    {
        uint256 cap = baseFeeBps(tvl, gradTvl);
        if (redLineWad == 0) return cap;
        if (cap <= C.FEE_FLOOR_BPS) return C.FEE_FLOOR_BPS;
        uint256 denom = tvlRef == 0 ? tvl : tvlRef;
        if (denom == 0) return cap;
        uint256 intensity = Math.mulDiv(volume, C.WAD, denom);
        if (intensity >= redLineWad) return cap;
        return C.FEE_FLOOR_BPS + Math.mulDiv(cap - C.FEE_FLOOR_BPS, intensity, redLineWad);
    }

    /// @notice `volume * 2^(-dt/halfLife)`. Integer halvings shift; the fraction uses exp(-x ln 2).
    ///         `halfLife == 0` or `dt == 0` leaves the volume unchanged. At least 64 half-lives forgets it.
    ///         Rounds down. Nothing in this function increases volume.
    function decayed(uint256 volume, uint256 dt, uint256 halfLife) internal pure returns (uint256) {
        if (volume == 0 || halfLife == 0 || dt == 0) return volume;
        uint256 halves = dt / halfLife;
        if (halves >= 64) return 0;
        uint256 v = volume >> halves;
        uint256 frac = dt % halfLife;
        if (frac == 0 || v == 0) return v;
        uint256 z = Math.mulDiv(frac, C.LN2_WAD, halfLife);
        return Math.mulDiv(v, _expNeg(z), C.WAD);
    }

    /// @notice Multiply by 1x through STALE_AFTER, then linearly to 5x over STALE_RAMP. Caps at FEE_ABS_CAP_BPS.
    function applyStale(uint256 bps, uint256 age) internal pure returns (uint256) {
        if (age <= C.STALE_AFTER) return _cap(bps);
        uint256 over = age - C.STALE_AFTER;
        uint256 multWad = over >= C.STALE_RAMP
            ? C.STALE_MAX_MULT * C.WAD
            : C.WAD + ((C.STALE_MAX_MULT - 1) * C.WAD * over) / C.STALE_RAMP;
        return _cap(Math.mulDiv(bps, multWad, C.WAD));
    }

    /// @notice 5x at TVL 0, linear to a permanent 1.2x at `gradTvl`. Unknown graduation stays at 5x.
    ///         Fee weight only. Never applied to principal.
    function boostWad(uint256 tvl, uint256 gradTvl) internal pure returns (uint256) {
        if (gradTvl == 0 || tvl >= gradTvl) {
            return gradTvl == 0 ? C.BOOST_START_WAD : C.BOOST_END_WAD;
        }
        return C.BOOST_END_WAD + ((C.BOOST_START_WAD - C.BOOST_END_WAD) * (gradTvl - tvl)) / gradTvl;
    }

    /// @notice max($500, 5% of TVL). Kept liquid so a vault outage does not stop ordinary sells.
    function buffer(uint256 tvl) internal pure returns (uint256) {
        uint256 pct = (tvl * C.BUFFER_TVL_BPS) / C.BPS;
        return pct > C.BUFFER_MIN ? pct : C.BUFFER_MIN;
    }

    /// @dev exp(-z) for z in WAD, z < ln(2). Twelve terms. If a term would underflow the sum, stop
    ///      and keep the larger sum (less decay, higher volume, higher fee).
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

    function _cap(uint256 bps) private pure returns (uint256) {
        return bps > C.FEE_ABS_CAP_BPS ? C.FEE_ABS_CAP_BPS : bps;
    }
}

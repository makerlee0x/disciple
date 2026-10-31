// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";

/// @title Fee, staleness, boost, and bridge-fee helpers for Disciple
/// @notice Fees are denominated in USDG on both buys and sells. Direction is "toward the anchor"
///         when the trade reduces |spot − anchor|, and "away" when it increases it.
library BridgeFee {
    /// @notice 2% at TVL 0, sliding to 0.3% as `tvl` approaches `gradTvl`. Unknown graduation → stay at 2%.
    function baseFeeBps(uint256 tvl, uint256 gradTvl) internal pure returns (uint256) {
        if (gradTvl == 0 || tvl >= gradTvl) {
            return gradTvl == 0 ? C.FEE_TINY_BPS : C.FEE_GRAD_BPS;
        }
        return C.FEE_GRAD_BPS + ((C.FEE_TINY_BPS - C.FEE_GRAD_BPS) * (gradTvl - tvl)) / gradTvl;
    }

    /// @notice Half the base fee toward the anchor, 1.5x away, 1x if the gap does not change.
    function directional(uint256 baseBps, uint256 spotBefore, uint256 spotAfter, uint256 anchor)
        internal
        pure
        returns (uint256)
    {
        uint256 g0 = spotBefore > anchor ? spotBefore - anchor : anchor - spotBefore;
        uint256 g1 = spotAfter > anchor ? spotAfter - anchor : anchor - spotAfter;
        if (g1 < g0) return baseBps / 2;
        if (g1 > g0) return baseBps + baseBps / 2;
        return baseBps;
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

    /// @notice 3.3x at TVL 0, linear to a permanent 1.2x at `gradTvl`. Unknown graduation stays at 3.3x.
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

    function _cap(uint256 bps) private pure returns (uint256) {
        return bps > C.FEE_ABS_CAP_BPS ? C.FEE_ABS_CAP_BPS : bps;
    }
}

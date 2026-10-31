// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Older remote view shape
/// @notice Disciple's lzRead calls `AnchorLens`, which returns this same `(priceWad, tvlWad)` pair from
///         `readV3` and `readV4Oracle`. `priceWad` is normalized USDG per 1e18 coin units. `tvlWad` is
///         the reference pool's TVL in 18-dec USDG. Both come from a 30-minute TWAP.
interface IEthAnchor {
    function latest() external view returns (uint256 priceWad, uint256 tvlWad);
}

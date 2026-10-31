// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title View Disciple asks LayerZero to staticcall on Ethereum
/// @notice `priceWad` is normalized USDG per 1e18 coin units (18-dec). `tvlWad` is the Ethereum pool's
///         TVL in 18-dec USD. Both are produced by the remote contract from a 30-minute TWAP — never by the keeper.
interface IEthAnchor {
    function latest() external view returns (uint256 priceWad, uint256 tvlWad);
}

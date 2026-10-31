// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TWAP surface a v4 reference hook may expose. Disciple does not interpret the pool's
///         currencies. `priceWad` is normalized quote (USDG) per 1e18 coin. `tvlWad` is that
///         pool's TVL in normalized quote. An AI/NVDA pool has to do the NVDA-to-USDG conversion
///         inside this function. The self-sampled path cannot.
interface IV4OracleHook {
    function consult(bytes32 poolId, uint32 secondsAgo) external view returns (uint256 priceWad, uint256 tvlWad);
}

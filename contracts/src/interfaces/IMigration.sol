// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Synthetic / atomic migrate to locked Uniswap v4 (§2 / LOCKED #5, #17)
interface IMigration {
    /// @notice Same-tx graduation: init v4 pool at curve-end price and seed full-range LockedLP position.
    /// @param priceWad Curve spot price (quote_wei * 1e18 / token_wei) at graduation — no price jump.
    /// @return poolId v4 PoolId as bytes32
    function migrate(address token, address quote, uint256 tokenAmount, uint256 quoteAmount, uint256 priceWad)
        external
        returns (bytes32 poolId);

    function isGraduated(address token) external view returns (bool);
    function poolIdOf(address token) external view returns (bytes32);
}

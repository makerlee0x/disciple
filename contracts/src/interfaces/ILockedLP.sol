// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Permanently locked LP + fee collection (§3 / LOCKED #16–#17)
/// @dev Remove-liquidity is not allowed. Post-grad LP fees → 100% treasury.
interface ILockedLP {
    function addLockedLiquidity(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (uint256 lpShares);

    /// @notice Collect trading fees from locked position; push 100% to treasury post-grad.
    function collectFees(address token) external returns (uint256 amount0, uint256 amount1);

    /// @dev Explicitly reverts — remove liquidity permanently disabled.
    function removeLiquidity(address token, uint256 shares) external;
}

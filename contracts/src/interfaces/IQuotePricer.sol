// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Launch-time quote/USD pricing
interface IQuotePricer {
    /// @notice USD value (18-dec WAD) of 1e18 raw units of `quote`.
    /// @dev For an 18-dec token this is "USD per 1 full token". For USDG (6 dec) it is 1e30.
    ///      Reverts if no USDG reference pool is registered for `quote`. Never returns 0.
    function quotePriceUsd(address quote) external view returns (uint256);
}

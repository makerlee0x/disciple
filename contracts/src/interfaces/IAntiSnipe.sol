// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Anti-snipe fee decay 77.7% → 0% over 7s (§2 / LOCKED #9)
/// @dev Snipe fee (above protocol 1%) destination: 100% locks quote into LP via FeeRouter.routeSnipeFee.
interface IAntiSnipe {
    function launchTimestamp(address token) external view returns (uint256);

    /// @return feeBps Current buy-side anti-snipe fee in BPS (ANTI_SNIPE_START → END over DURATION).
    function currentFeeBps(address token) external view returns (uint256 feeBps);

    /// @notice Apply snipe fee on a buy; caller routes feeAmount via FeeRouter.routeSnipeFee (100% LP).
    function applyBuyFee(address token, uint256 quoteIn) external view returns (uint256 feeAmount, uint256 feeBps);
}

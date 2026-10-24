// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title LEGACY anti-snipe fee schedule interface: 99% → 0% over 77s (Constants.ANTI_SNIPE_*)
/// @dev Not used by mode-rules-v2 curves, which tax inline and hold the tax in BondingCurve.snipeEscrow
///      (→ LockedLP compound bucket at graduation, not the floor; → RewardsVault via releaseSnipeEscrow after the timeout).
interface IAntiSnipe {
    function launchTimestamp(address token) external view returns (uint256);

    /// @return feeBps Current buy-side anti-snipe fee in BPS (ANTI_SNIPE_START → END over DURATION).
    function currentFeeBps(address token) external view returns (uint256 feeBps);

    /// @notice Apply snipe fee on a buy; legacy callers routed feeAmount via FeeRouter.routeSnipeFee (70/30); v2 curves do not.
    function applyBuyFee(address token, uint256 quoteIn) external view returns (uint256 feeAmount, uint256 feeBps);
}

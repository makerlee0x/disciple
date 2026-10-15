// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Fee routing — 33/33/33/1 + creator tax + snipe→70% rewards/30% treasury (§3 / LOCKED #11–#15, §2 #9)
interface IFeeRouter {
    function creatorAccrued(address token, address creator) external view returns (uint256);
    function referrerAccrued(address referrer, address quote) external view returns (uint256);

    function claimCreatorFees(address token) external returns (uint256 amount);
    function claimReferrerFees(address quote) external returns (uint256 amount);

    /// @notice Called by curve/AMM on each trade. Treasury auto-pushed; LP lock auto-added; creator/referrer accrue.
    function routeTradeFee(
        address token,
        address quote,
        address trader,
        address creator,
        uint256 feeAmount,
        uint256 creatorTaxAmount
    ) external;

    /// @notice Post-grad hook fee with `donated` already donated to in-range LPs (deducted from the LP-lock share).
    function routeHookFee(
        address token,
        address feeToken,
        address trader,
        address creator,
        uint256 feeAmount,
        uint256 donated
    ) external;

    /// @notice Anti-snipe fee (above protocol 1%) → 70% RewardsVault / 30% treasury (§2 / LOCKED #9 rev.).
    function routeSnipeFee(address token, address quote, uint256 snipeFeeAmount) external;
}

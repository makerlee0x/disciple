// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Fee routing — 33/33/33/1 + creator tax + snipe→LP (§3 / LOCKED #11–#15, §2 #9)
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

    /// @notice Anti-snipe fee (above protocol 1%) → 100% LP lock (§2 / LOCKED #9).
    function routeSnipeFee(address token, address quote, uint256 snipeFeeAmount) external;
}

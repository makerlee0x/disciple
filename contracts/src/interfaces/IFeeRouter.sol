// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Fee routing — 33/33/33/1 + creator tax (§3 / LOCKED #11–#15); legacy snipe 70/30 route (unused by v2 curves)
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

    /// @notice Post-grad hook fee (full 1% fee transferred; split 33/33/33/1, LP share → LockedLP).
    /// @return compoundReady true if LockedLP's compound buckets for `token` now hold both sides (hook may compound).
    function routeHookFee(address token, address feeToken, address trader, address creator, uint256 feeAmount)
        external
        returns (bool compoundReady);

    /// @notice LEGACY: snipe fee → 70% RewardsVault / 30% treasury. Mode-rules-v2 curves never call it (sniper tax
    ///         stays in BondingCurve.snipeEscrow → LockedLP compound bucket at graduation / RewardsVault after timeout).
    function routeSnipeFee(address token, address quote, uint256 snipeFeeAmount) external;
}

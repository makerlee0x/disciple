// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Integration surface for the protocol (FeeRouter / Router / hook / keeper). NOT wired into live contracts.
/// @dev Integration notes (see docs/rockets-v0.md §10):
///  - FeeRouter would carve `rocketBps` (default 10% of the whole fee, i.e. 1000/3300 of the treasury slice) and call
///    `depositFees(amount)` after approving USDG. Non-USDG quotes must be swapped to USDG by a keeper first.
///  - Router/hook (or a keeper reading TradeFeeRouted events) calls `reportActivity(trader, notionalUsdg)`
///    with wash-filtered notional; the reporter role is the trust boundary.
interface IRocketFeeSink {
    function depositFees(uint256 amount) external;
    function reportActivity(address wallet, uint256 notionalUsdg) external;
}

/// @notice Trailing 7-day protocol fee volume feed used for auction pricing.
interface IRocketFeeFeed {
    /// @return fees7d total protocol fees (USDG units) over the trailing 7 days; updatedAt timestamp of the post.
    function trailingFees7d() external view returns (uint256 fees7d, uint256 updatedAt);
}

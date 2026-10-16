// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TWAP altitude stream (emitted by BondingCurve pre-grad and DiscipleHook post-grad, after every Trade)
/// @notice GAME/SITE must drive tier breaks ("altitude") from these events, never from Trade.mcapAfterUsd (spot).
interface IAltitudeEvents {
    /// @param twapMcapUsd  USD WAD mcap at the time-weighted mean price over `window` seconds
    /// @param spotMcapUsd  USD WAD mcap at the post-trade spot price (display only; same as Trade.mcapAfterUsd)
    /// @param tier         altitude tier index 0..17 of twapMcapUsd
    /// @param window       seconds actually covered by the TWAP (≤ configured window while history is young)
    event AltitudeUpdate(address indexed token, uint256 twapMcapUsd, uint256 spotMcapUsd, uint8 tier, uint32 window);
    /// @notice TWAP tier changed (up or down). Emitted right after the AltitudeUpdate that caused it.
    event TierBreak(address indexed token, uint8 fromTier, uint8 toTier, uint256 twapMcapUsd);
}

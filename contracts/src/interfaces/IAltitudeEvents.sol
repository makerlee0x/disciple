// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Altitude stream (emitted by BondingCurve pre-grad and AscensionHook post-grad, right after every Trade)
/// @notice Altitude is SPOT. Pre-grad (BondingCurve): `mcapUsd` equals the preceding Trade.mcapAfterUsd. Post-grad
///         (AscensionHook): `mcapUsd` = spot mcap from the preceding Trade.sqrtPriceAfter at the pool's LAUNCH-TIME
///         quote/USD price (no live oracle call per swap, gas G-1). `tier` is the 0..17 index of the constitution
///         ladder (web/lib/config.ts TIERS).
interface IAltitudeEvents {
    event AltitudeUpdate(address indexed token, uint256 mcapUsd, uint8 tier);
    /// @notice Spot tier changed (up or down) on this trade. Emitted right after the AltitudeUpdate.
    event TierBreak(address indexed token, uint8 fromTier, uint8 toTier, uint256 mcapUsd);
}

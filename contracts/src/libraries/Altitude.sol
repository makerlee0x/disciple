// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title 18-tier altitude ladder (constitution §9, LOCKED 2026-10-15), indexed 0..17
/// @dev Same breakpoints as Constants.TIER_*_LO_USD and web/lib/config.ts TIERS. Below $12K → 0 (LAUNCH PAD).
library Altitude {
    uint8 internal constant TIER_COUNT = 18;

    function tierOf(uint256 mcapUsdWad) internal pure returns (uint8 t) {
        uint256 d = mcapUsdWad / 1e18; // whole dollars
        uint32[17] memory lo = [
            uint32(12_000),
            18_000,
            25_000,
            33_000,
            55_000,
            100_000,
            333_000,
            777_000,
            1_200_000,
            3_300_000,
            7_700_000,
            33_000_000,
            77_000_000,
            120_000_000,
            777_000_000,
            1_200_000_000,
            3_300_000_000
        ];
        for (uint256 i; i < 17; i++) {
            if (d >= lo[i]) t = uint8(i + 1);
            else break;
        }
    }
}

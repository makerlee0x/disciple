// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Constants} from "./Constants.sol";

/// @title Graduation floor band geometry (phase 3a)
/// @notice 16 USDG-only bands below the graduation spot. Offsets are in tick spacings (60) measured from `base`:
///         token = currency0 → bands sit BELOW base (USDG = currency1); token = currency1 → ABOVE base (USDG =
///         currency0). Either way the token's price falls into them. Bands 0..3: layer A (30% flat, 12 spacings each,
///         spot → 0.75x). Bands 4..15: layer B (70%, 32 spacings each = equal log-price width, spot → 0.1x), USDG
///         weight rising 4x geometrically (4^(j/11)) from the top band (j = 0) to the bottom band (j = 11).
library FloorBands {
    int24 internal constant SPACING = 60;
    /// @dev layer-B weights in bps of the floor, 16 bits each, j = 0 (top) .. 11 (bottom); sum 7000, last absorbs
    ///      rounding: 266 301 342 388 440 499 566 642 728 826 937 1065
    uint256 internal constant BOTTOM_BPS_PACKED = 0x42903a9033a02d80282023601f301b801840156012d010a;

    /// @return lo near edge (spacings from base) @return hi far edge @return bps share of the floor budget
    function band(uint256 i) internal pure returns (uint256 lo, uint256 hi, uint256 bps) {
        uint256 nFlat = Constants.FLOOR_FLAT_BANDS;
        if (i < nFlat) {
            uint256 w = Constants.FLOOR_FLAT_SPACINGS / nFlat;
            return (w * i, w * (i + 1), Constants.FLOOR_FLAT_BPS / nFlat);
        }
        uint256 j = i - nFlat;
        uint256 wb = Constants.FLOOR_BOTTOM_SPACINGS / (Constants.MAX_FLOOR_BANDS - nFlat);
        return (wb * j, wb * (j + 1), uint16(BOTTOM_BPS_PACKED >> (16 * j)));
    }

    /// @notice First aligned tick strictly on the USDG side of `cur` (token=c0: floor(cur); token=c1: floor(cur)+60).
    function baseTick(int24 cur, bool tokenIsC0) internal pure returns (int24 base) {
        base = (cur / SPACING) * SPACING;
        if (cur < 0 && cur % SPACING != 0) base -= SPACING; // floor toward -inf
        if (!tokenIsC0) base += SPACING;
    }

    function ticks(int24 base, bool tokenIsC0, uint256 i) internal pure returns (int24 tickLower, int24 tickUpper) {
        (uint256 lo, uint256 hi,) = band(i);
        int24 l = int24(uint24(lo)) * SPACING;
        int24 h = int24(uint24(hi)) * SPACING;
        return tokenIsC0 ? (base - h, base - l) : (base + l, base + h);
    }

    /// @notice Per-band salt, distinct from the main position's salt (bytes32(uint160(token))) and from each other.
    function salt(address token, uint256 i) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(token)) | ((i + 1) << 160));
    }
}

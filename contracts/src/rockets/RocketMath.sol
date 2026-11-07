// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal 1e18 fixed-point log2 / 2^-y helpers for smooth exponential auction decay.
library RocketMath {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant LN2 = 693147180559945309;

    /// @dev log2(x) for x >= 1e18 (1e18-scaled in and out). ~1e-15 relative precision.
    function log2(uint256 x) internal pure returns (uint256 r) {
        require(x >= ONE, "log2<1");
        uint256 n;
        uint256 q = x / ONE;
        while (q >= 2) {
            q >>= 1;
            n++;
        }
        r = n * ONE;
        uint256 y = x >> n; // in [1,2)
        if (y == ONE) return r;
        for (uint256 delta = ONE / 2; delta > 0; delta >>= 1) {
            y = y * y / ONE;
            if (y >= 2 * ONE) {
                r += delta;
                y >>= 1;
            }
        }
    }

    /// @dev a / 2^y with y 1e18-scaled.
    function divPow2(uint256 a, uint256 y) internal pure returns (uint256) {
        uint256 i = y / ONE;
        if (i >= 255) return 0;
        uint256 f = y % ONE; // 2^-f = e^(-f ln2)
        uint256 z = f * LN2 / ONE; // < 0.7
        // e^-z via Taylor series
        uint256 term = ONE;
        uint256 sumPos = ONE;
        uint256 sumNeg;
        for (uint256 k = 1; k < 24; ++k) {
            term = term * z / ONE / k;
            if (term == 0) break;
            if (k % 2 == 1) sumNeg += term;
            else sumPos += term;
        }
        return (a >> i) * (sumPos - sumNeg) / ONE;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Full-precision market cap math
/// @notice Computes mcap directly from reserves / sqrtPriceX96 instead of from a WAD spot price. The WAD price
///         (quote raw * 1e18 / token raw) is a single-digit integer for 6-decimal quotes (~4.7 at a $33K graduation
///         with the 7B x 1e18 supply), so flooring it first under-reported mcap by up to ~15% (e.g. $28K vs $33K).
///         Here mcap is floored only once, at the end, so it is exact to 1 raw quote unit for any decimals.
library McapMath {
    /// @notice mcap in raw quote units = supply * price, with price = sqrtP^2 / 2^192 (c1 per c0).
    function mcapQuoteFromSqrt(uint160 sqrtP, bool tokenIsC0, uint256 supply) internal pure returns (uint256) {
        if (sqrtP == 0) return 0;
        if (tokenIsC0) return Math.mulDiv(Math.mulDiv(sqrtP, sqrtP, 1 << 64), supply, 1 << 128);
        return Math.mulDiv(Math.mulDiv(supply, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    /// @notice USD WAD mcap; quoteUsd = USD WAD per 1e18 raw quote (repo convention).
    function mcapUsdFromSqrt(uint160 sqrtP, bool tokenIsC0, uint256 supply, uint256 quoteUsd)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(mcapQuoteFromSqrt(sqrtP, tokenIsC0, supply), quoteUsd, 1e18);
    }
}

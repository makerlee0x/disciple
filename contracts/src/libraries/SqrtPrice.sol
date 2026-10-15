// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Encode Uniswap v4 sqrtPriceX96 from curve prices.
library SqrtPrice {
    /// @param priceWad Quote per token in WAD (1e18 scale), as on the bonding curve.
    /// @param tokenIsCurrency0 True if token address < quote address (token = currency0).
    function fromPriceWad(uint256 priceWad, bool tokenIsCurrency0) internal pure returns (uint160 sqrtPriceX96) {
        require(priceWad > 0, "SqrtPrice: zero");
        uint256 ratioX192;
        if (tokenIsCurrency0) {
            ratioX192 = Math.mulDiv(priceWad, 1 << 192, 1e18);
        } else {
            ratioX192 = Math.mulDiv(1e18, 1 << 192, priceWad);
        }
        return _toSqrt(ratioX192);
    }

    /// @notice Full-precision sqrtPriceX96 from virtual reserves (price = quoteReserve / tokenReserve).
    /// @dev Avoids WAD truncation for low-decimal quotes (e.g. 6-dec USDG, where priceWad ~ single digits).
    function fromReserves(uint256 quoteReserve, uint256 tokenReserve, bool tokenIsCurrency0)
        internal
        pure
        returns (uint160)
    {
        require(quoteReserve > 0 && tokenReserve > 0, "SqrtPrice: zero");
        uint256 ratioX192 = tokenIsCurrency0
            ? Math.mulDiv(quoteReserve, 1 << 192, tokenReserve)
            : Math.mulDiv(tokenReserve, 1 << 192, quoteReserve);
        return _toSqrt(ratioX192);
    }

    function _toSqrt(uint256 ratioX192) private pure returns (uint160 sqrtPriceX96) {
        uint256 s = Math.sqrt(ratioX192);
        require(s <= type(uint160).max, "SqrtPrice: overflow");
        sqrtPriceX96 = uint160(s);
        require(sqrtPriceX96 > 0, "SqrtPrice: zero sqrt");
    }
}

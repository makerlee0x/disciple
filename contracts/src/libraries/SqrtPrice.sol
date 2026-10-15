// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Encode Uniswap v4 sqrtPriceX96 from a WAD price (quote_wei * 1e18 / token_wei).
library SqrtPrice {
    /// @param priceWad Quote per token in WAD (1e18 scale), as on the bonding curve.
    /// @param tokenIsCurrency0 True if token address < quote address (token = currency0).
    function fromPriceWad(uint256 priceWad, bool tokenIsCurrency0) internal pure returns (uint160 sqrtPriceX96) {
        require(priceWad > 0, "SqrtPrice: zero");
        // price01 = currency1 / currency0
        // If token is c0: price01 = quote/token = priceWad/1e18
        // If token is c1: price01 = token/quote = 1e18/priceWad
        uint256 ratioX192;
        if (tokenIsCurrency0) {
            // priceWad/1e18 * 2^192 = priceWad * 2^192 / 1e18
            ratioX192 = Math.mulDiv(priceWad, 1 << 192, 1e18);
        } else {
            ratioX192 = Math.mulDiv(1e18, 1 << 192, priceWad);
        }
        uint256 sqrt = Math.sqrt(ratioX192);
        require(sqrt <= type(uint160).max, "SqrtPrice: overflow");
        sqrtPriceX96 = uint160(sqrt);
        require(sqrtPriceX96 > 0, "SqrtPrice: zero sqrt");
    }
}

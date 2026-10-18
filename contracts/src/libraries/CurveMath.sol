// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Constants} from "./Constants.sol";
import {FeeMath} from "./FeeMath.sol";

/// @title Pump-style CPAMM bonding curve math (§2 / LOCKED #5–#7)
/// @notice Single constant-product virtual-reserve curve.
///         Start mcap $7K → graduation (Outer Space) $33K exactly when tokensSold == 72% of supply.
/// @dev Quote amounts are raw quote wei. USD targets convert via `quotePriceUsd`
///      (USD WAD per 1 full quote token) at launch. Every trade rounds against the user.
library CurveMath {
    uint256 internal constant WAD = 1e18;

    /// @dev Immutable curve geometry.
    struct Params {
        uint256 totalSupply;
        uint256 sCurve; // tokens sold at graduation (Outer Space, 72% of supply)
        uint256 x0; // virtual quote reserve at s=0
        uint256 y0; // virtual token reserve at s=0
        uint256 quotePriceUsd; // USD WAD per 1 full quote token
    }

    error InvalidQuotePrice();
    error InsufficientLiquidity();

    /// @notice Build params from constitution USD targets and the quote's USD price at launch.
    /// @param quotePriceUsd USD value of 1 full quote token, 18-dec WAD (e.g. 1e18 for USDG).
    function makeParams(uint256 quotePriceUsd) internal pure returns (Params memory p) {
        if (quotePriceUsd == 0) revert InvalidQuotePrice();

        p.totalSupply = Constants.TOTAL_SUPPLY;
        p.sCurve = FeeMath.curveSoldSupply();
        p.quotePriceUsd = quotePriceUsd;

        // mcapQuote = mcapUsd * WAD / quotePriceUsd
        uint256 m0Q = Math.mulDiv(Constants.START_MCAP_USD, WAD, quotePriceUsd);
        uint256 m1Q = Math.mulDiv(Constants.GRADUATION_MCAP_USD, WAD, quotePriceUsd);

        // Fit y0 so M(sCurve)=M1: M1/M0 = (y0/(y0-sCurve))^2
        // y0 = sCurve * √r / (√r - 1), r = M1/M0
        uint256 rWad = Math.mulDiv(m1Q, WAD, m0Q);
        uint256 sqrtRWad = Math.sqrt(rWad * WAD); // √r * WAD (floored)
        require(sqrtRWad > WAD, "CurveMath: r");
        p.y0 = Math.mulDiv(p.sCurve, sqrtRWad, sqrtRWad - WAD);
        // x0 = (M0/S) * y0
        p.x0 = Math.mulDiv(m0Q, p.y0, p.totalSupply);
    }

    /// @notice Virtual quote reserve at `tokensSold`.
    function virtualQuote(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        uint256 y = p.y0 - tokensSold;
        return Math.mulDiv(p.x0, p.y0, y);
    }

    /// @notice Virtual token reserve at `tokensSold`.
    function virtualToken(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        return p.y0 - tokensSold;
    }

    /// @notice Spot price as quote_wei * WAD / token_wei at `tokensSold`.
    function spotPriceWad(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        uint256 y = p.y0 - tokensSold;
        uint256 x = Math.mulDiv(p.x0, p.y0, y);
        return Math.mulDiv(x, WAD, y);
    }

    /// @notice Market cap in USD WAD (18-dec dollars).
    /// @dev Full precision: x * S / y (not via the floored WAD spot price, which loses up to ~15% for 6-dec quotes).
    function marketCapUsd(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        return Math.mulDiv(marketCapQuote(p, tokensSold), p.quotePriceUsd, WAD);
    }

    /// @notice Market cap in raw quote wei.
    function marketCapQuote(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        uint256 y = p.y0 - tokensSold;
        uint256 x = Math.mulDiv(p.x0, p.y0, y);
        return Math.mulDiv(x, p.totalSupply, y);
    }

    /// @notice Quote wei to buy `tokensOut` from `tokensSold` (floor).
    function quoteInForTokens(Params memory p, uint256 tokensSold, uint256 tokensOut) internal pure returns (uint256) {
        if (tokensOut == 0) return 0;
        if (tokensSold + tokensOut > p.sCurve) revert InsufficientLiquidity();
        // dx = x * dy / (y - dy)
        uint256 y = p.y0 - tokensSold;
        uint256 x = Math.mulDiv(p.x0, p.y0, y);
        return Math.mulDiv(x, tokensOut, y - tokensOut);
    }

    /// @notice Tokens out for `quoteIn` from `tokensSold` (floor — round against buyer).
    function tokensOutForQuote(Params memory p, uint256 tokensSold, uint256 quoteIn)
        internal
        pure
        returns (uint256 tokensOut)
    {
        if (quoteIn == 0) return 0;
        if (tokensSold >= p.sCurve) revert InsufficientLiquidity();

        uint256 remaining = p.sCurve - tokensSold;
        // dy = y * dx / (x + dx)
        uint256 y = p.y0 - tokensSold;
        uint256 x = Math.mulDiv(p.x0, p.y0, y);
        tokensOut = Math.mulDiv(y, quoteIn, x + quoteIn);
        if (tokensOut > remaining) tokensOut = remaining;
    }

    /// @notice Quote wei for selling `tokensIn` down from `tokensSold` (floor — against seller).
    /// @dev Floors CPAMM output, then clamps (closed form, ceil rounding) so buy-back cannot exceed tokensIn
    ///      (eliminates rare floor-asymmetry rounding profit on sell→buy).
    function quoteOutForTokens(Params memory p, uint256 tokensSold, uint256 tokensIn)
        internal
        pure
        returns (uint256 q)
    {
        if (tokensIn == 0) return 0;
        if (tokensIn > tokensSold) revert InsufficientLiquidity();
        // At sold=s: y=y0-s, x=k/y. Selling dy: quoteOut = x * dy / (y + dy)
        uint256 y = p.y0 - tokensSold;
        uint256 x = Math.mulDiv(p.x0, p.y0, y);
        q = Math.mulDiv(x, tokensIn, y + tokensIn);
        // Audit G-7: closed form of the old one-wei step-down = the largest q with
        // tokensOutForQuote(sAfter, q) <= tokensIn. At sAfter: y' = y + T, x' = floor(x0*y0 / y').
        // floor(y'q / (x'+q)) <= T  <=>  q(y' - T - 1) < (T+1)x'  <=>  q <= ceil((T+1)x' / (y-1)) - 1.
        if (y > 1) {
            uint256 xa = Math.mulDiv(p.x0, p.y0, y + tokensIn);
            uint256 qMax = Math.mulDiv(tokensIn + 1, xa, y - 1, Math.Rounding.Ceil) - 1;
            if (q > qMax) q = qMax;
        }
    }
}

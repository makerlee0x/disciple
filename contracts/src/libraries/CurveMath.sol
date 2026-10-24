// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Constants} from "./Constants.sol";
import {FeeMath} from "./FeeMath.sol";

/// @title Steep bonding curve math (§2 / LOCKED #5–#7, curve #1 rev. 2026-10-23)
/// @notice Market cap as a function of curve progress g = sold / sCurve ∈ [0, 1]:
///             m(g) = M0 / (1 − a·g)²  +  T · g^30
///         M0 = START_MCAP ($3,333). The first term is a constant-product (virtual reserve) curve fitted so it reaches
///         CURVE_MID_MCAP ($15,000) at g = 1 (a = 1 − √(M0/mid)); the tail T·g^30 (T = $33,333 − $15,000) is ~0 for most
///         of the curve and adds the steep finish, so m(1) = GRADUATION_MCAP ($33,333) exactly at CURVE_SOLD_BPS sold.
///         In token units: CP part = virtual reserves x0, y0 (y0 = sCurve / a, x0 = M0·y0 / S); tail part price
///         = tail·(s/sCurve)^30 / S, with `tail` = T in quote wei.
/// @dev Cost of [s1, s2] in closed form:  x0·y0·(s2 − s1) / ((y0 − s1)(y0 − s2))  +  tail·sCurve·(g2^31 − g1^31) / (31·S).
///      Powers use a 1e36 fixed point (RAY) so the tail is exact to < 1 wei. Every trade rounds against the user:
///      buy cost rounds UP, sell proceeds round DOWN, tokens out for a quote input round DOWN (Newton from above).
library CurveMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e36;
    uint256 internal constant MAX_NEWTON = 64;

    /// @dev Immutable curve geometry.
    struct Params {
        uint256 totalSupply;
        uint256 sCurve; // tokens sold at graduation (Outer Space, CURVE_SOLD_BPS of supply)
        uint256 x0; // CP part: virtual quote reserve at s=0
        uint256 y0; // CP part: virtual token reserve at s=0 (= sCurve / a)
        uint256 quotePriceUsd; // USD WAD per 1 full quote token
        uint256 tail; // tail mcap at g=1, quote wei (T: CP part + tail = GRADUATION exactly at sCurve)
    }

    error InvalidQuotePrice();
    error InsufficientLiquidity();
    error NoConvergence();

    /// @notice Build params from constitution USD targets and the quote's USD price at launch.
    /// @param quotePriceUsd USD value of 1 full quote token, 18-dec WAD (e.g. 1e18 for USDG).
    function makeParams(uint256 quotePriceUsd) internal pure returns (Params memory p) {
        if (quotePriceUsd == 0) revert InvalidQuotePrice();

        p.totalSupply = Constants.TOTAL_SUPPLY;
        p.sCurve = FeeMath.curveSoldSupply();
        p.quotePriceUsd = quotePriceUsd;

        uint256 m0Q = Math.mulDiv(Constants.START_MCAP_USD, WAD, quotePriceUsd);
        uint256 mMidQ = Math.mulDiv(Constants.CURVE_MID_MCAP_USD, WAD, quotePriceUsd);
        uint256 m1Q = Math.mulDiv(Constants.GRADUATION_MCAP_USD, WAD, quotePriceUsd);

        // CP part reaches mid at sCurve: mid/M0 = (y0/(y0 − sCurve))²  ⇒  y0 = sCurve·√r/(√r − 1), r = mid/M0
        uint256 sqrtRWad = Math.sqrt(Math.mulDiv(mMidQ, WAD, m0Q) * WAD); // √r · WAD (floored)
        require(sqrtRWad > WAD, "CurveMath: r");
        p.y0 = Math.mulDiv(p.sCurve, sqrtRWad, sqrtRWad - WAD);
        p.x0 = Math.mulDiv(m0Q, p.y0, p.totalSupply);
        // Tail closes the gap so marketCapQuote(sCurve) == m1Q exactly (CP part floors, tail·g^30 = tail at g = 1).
        uint256 cpEnd = _cpMcap(p, p.sCurve);
        require(m1Q > cpEnd, "CurveMath: tail");
        p.tail = m1Q - cpEnd;
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice CP-part virtual quote reserve at `tokensSold` (the tail has no reserve analogue).
    function virtualQuote(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        return Math.mulDiv(p.x0, p.y0, p.y0 - tokensSold);
    }

    /// @notice CP-part virtual token reserve at `tokensSold`.
    function virtualToken(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        return p.y0 - tokensSold;
    }

    /// @notice Market cap in raw quote wei at `tokensSold` (floor).
    function marketCapQuote(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        return _cpMcap(p, tokensSold) + _tailMcap(p, tokensSold, false);
    }

    /// @notice Market cap in USD WAD (18-dec dollars).
    function marketCapUsd(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        return Math.mulDiv(marketCapQuote(p, tokensSold), p.quotePriceUsd, WAD);
    }

    /// @notice Spot price as quote_wei * WAD / token_wei at `tokensSold` (floor).
    function spotPriceWad(Params memory p, uint256 tokensSold) internal pure returns (uint256) {
        return Math.mulDiv(marketCapQuote(p, tokensSold), WAD, p.totalSupply);
    }

    // ─────────────────────────────── trades ──────────────────────────────

    /// @notice Quote wei to buy `tokensOut` from `tokensSold` (ceil — against the buyer).
    function quoteInForTokens(Params memory p, uint256 tokensSold, uint256 tokensOut) internal pure returns (uint256) {
        if (tokensOut == 0) return 0;
        if (tokensSold + tokensOut > p.sCurve) revert InsufficientLiquidity();
        return costUp(p, tokensSold, tokensSold + tokensOut);
    }

    /// @notice Tokens out for `quoteIn` from `tokensSold` (floor — against the buyer), clamped to remaining supply.
    function tokensOutForQuote(Params memory p, uint256 tokensSold, uint256 quoteIn) internal pure returns (uint256) {
        return tokensOutForQuoteCapped(p, tokensSold, quoteIn, type(uint256).max);
    }

    /// @notice As tokensOutForQuote, but never above `cap` (returns `cap` when it is affordable).
    /// @dev Result dt always satisfies costUp(s, s + dt) <= quoteIn. Newton from above on the convex cost: start at the
    ///      CP-only inverse (the tail only adds cost, so it is >= the root), step by (cost − q) / price at the right end
    ///      (the largest slope on the interval), so iterates never cross below the root and decrease monotonically.
    function tokensOutForQuoteCapped(Params memory p, uint256 tokensSold, uint256 quoteIn, uint256 cap)
        internal
        pure
        returns (uint256 dt)
    {
        if (quoteIn == 0 || cap == 0) return 0;
        if (tokensSold >= p.sCurve) revert InsufficientLiquidity();
        uint256 rem = p.sCurve - tokensSold;
        if (cap < rem) rem = cap;
        uint256 y = p.y0 - tokensSold;
        dt = Math.mulDiv(y, quoteIn, Math.mulDiv(p.x0, p.y0, y) + quoteIn) + 1; // CP-only inverse (+1: safely above)
        if (dt > rem) dt = rem;
        for (uint256 i; i < MAX_NEWTON; ++i) {
            uint256 c = costUp(p, tokensSold, tokensSold + dt);
            if (c <= quoteIn) return dt;
            uint256 pr = _priceWadUp(p, tokensSold + dt);
            uint256 step = Math.mulDiv(c - quoteIn, WAD, pr);
            if (step == 0) step = 1;
            if (step >= dt) return 0;
            dt -= step;
        }
        revert NoConvergence();
    }

    /// @notice Gross quote wei for selling `tokensIn` down from `tokensSold` (floor — against the seller).
    /// @dev Also clamped so the proceeds cannot buy back more than `tokensIn` (audit G-7: no sell→buy dust profit):
    ///      q <= costUp(sAfter, sAfter + tokensIn + 1) − 1  ⇒  tokensOutForQuote(sAfter, q) <= tokensIn.
    function quoteOutForTokens(Params memory p, uint256 tokensSold, uint256 tokensIn) internal pure returns (uint256 q) {
        if (tokensIn == 0) return 0;
        if (tokensIn > tokensSold) revert InsufficientLiquidity();
        uint256 sAfter = tokensSold - tokensIn;
        q = costDown(p, sAfter, tokensSold);
        uint256 qMax = costUp(p, sAfter, tokensSold + 1) - 1;
        if (q > qMax) q = qMax;
    }

    // ──────────────────────────── cost integral ──────────────────────────

    /// @notice Exact quote cost of the curve between s1 <= s2, rounded up.
    function costUp(Params memory p, uint256 s1, uint256 s2) internal pure returns (uint256) {
        if (s2 <= s1) return 0;
        uint256 cp = Math.mulDiv(p.x0 * p.y0, s2 - s1, (p.y0 - s1) * (p.y0 - s2), Math.Rounding.Ceil);
        uint256 hi = _pow31(_g(p, s2, true), true);
        uint256 lo = _pow31(_g(p, s1, false), false);
        return cp + Math.mulDiv(p.tail * p.sCurve, hi - lo, 31 * p.totalSupply * RAY, Math.Rounding.Ceil);
    }

    /// @notice Exact quote cost of the curve between s1 <= s2, rounded down.
    function costDown(Params memory p, uint256 s1, uint256 s2) internal pure returns (uint256) {
        if (s2 <= s1) return 0;
        uint256 cp = Math.mulDiv(p.x0 * p.y0, s2 - s1, (p.y0 - s1) * (p.y0 - s2));
        uint256 hi = _pow31(_g(p, s2, false), false);
        uint256 lo = _pow31(_g(p, s1, true), true);
        return cp + (hi > lo ? Math.mulDiv(p.tail * p.sCurve, hi - lo, 31 * p.totalSupply * RAY) : 0);
    }

    // ─────────────────────────────── internals ───────────────────────────

    function _cpMcap(Params memory p, uint256 s) private pure returns (uint256) {
        uint256 y = p.y0 - s;
        return Math.mulDiv(Math.mulDiv(p.x0, p.y0, y), p.totalSupply, y);
    }

    function _tailMcap(Params memory p, uint256 s, bool up) private pure returns (uint256) {
        if (s == 0) return 0;
        return Math.mulDiv(p.tail, _pow30(_g(p, s, up), up), RAY, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    /// @dev Spot price (quote wei · WAD / token wei), rounded up (Newton step size: never overshoots the root).
    function _priceWadUp(Params memory p, uint256 s) private pure returns (uint256) {
        uint256 y = p.y0 - s;
        uint256 cp = Math.mulDiv(p.x0 * p.y0, p.totalSupply, y * y, Math.Rounding.Ceil);
        return Math.mulDiv(cp + _tailMcap(p, s, true), WAD, p.totalSupply, Math.Rounding.Ceil);
    }

    function _g(Params memory p, uint256 s, bool up) private pure returns (uint256) {
        return Math.mulDiv(s, RAY, p.sCurve, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    function _m(uint256 a, uint256 b, bool up) private pure returns (uint256) {
        return Math.mulDiv(a, b, RAY, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    /// @dev g^30 in RAY (g <= RAY), consistently rounded down or up.
    function _pow30(uint256 g, bool up) private pure returns (uint256) {
        if (g == 0) return 0;
        uint256 g2 = _m(g, g, up);
        uint256 g4 = _m(g2, g2, up);
        uint256 g8 = _m(g4, g4, up);
        uint256 g16 = _m(g8, g8, up);
        return _m(_m(_m(g16, g8, up), g4, up), g2, up);
    }

    function _pow31(uint256 g, bool up) private pure returns (uint256) {
        return g == 0 ? 0 : _m(_pow30(g, up), g, up);
    }
}

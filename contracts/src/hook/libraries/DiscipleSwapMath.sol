// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FixedPointMathLib as FPM} from "./vendor/FixedPointMathLib.sol";

/// @title Disciple swap engine math (curve core)
/// @notice Pure pricing for one Disciple pool at frozen external state. No storage, no LP or payout logic.
///
///         Curve (lambda = 1). With coin reserve u and quote reserve v, the marginal price is k * v/u, where
///             k = C * G_buy on buys and C / G_sell on sells,  C = P_ref / T,  G = H / (1 - f).
///         P_ref is the anchor price, T the seed ratio v0/u0, H the price-move premium and f the per-side fee.
///         On a curve segment v * u^k is constant, so every fill has a closed form:
///             buy, quote in Q:   u1 = u0 * (v0 / (v0 + Q))^(1/k)
///             sell, coin in Q:   v1 = v0 * (u0 / (u0 + Q))^k
///
///         Match boundary p: a buy never pays less than p per coin, a sell never receives more than p. Where the
///         curve would cross p, the fill runs along the straight line v + p*u = const until the curve's marginal
///         price reaches p, then follows the curve. p == 0 means no boundary.
///
///         Rounding always favours the pool. Every pow is computed as the reserve that REMAINS after the fill,
///         rounded up, and the fill is the difference. That keeps the error bounded by a few wei of the reserve,
///         not of the fill, so small trades cannot exploit cancellation. Solady's lnWad/expWad error (about 1 wei)
///         is covered by LN_SLACK and EXP_SLACK, which are added against the trader in the exponent.
///
///         Units: reserves and amounts in raw token units; prices (P_ref, T, p) as X128 fixed point (raw quote per
///         raw coin times 2^128); k, G and H as WAD. Fee in pips (1e6 = 100%), like Uniswap v4.
///
///         The Python mirror sim/swap-engine/engine.py is a line-for-line copy used for offline fuzzing and
///         test vectors. Keep the two in step.
library DiscipleSwapMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant FEE_DENOM = 1e6;
    uint256 internal constant BPS = 10_000;

    /// @dev Added to ln against the trader. Solady lnWad error is <= ~1.05 wei; 1000 also keeps split <= whole.
    uint256 internal constant LN_SLACK = 1000;
    /// @dev Added to exp against the trader. Solady expWad error is <= ~1 wei below 1.0.
    uint256 internal constant EXP_SLACK = 2;
    /// @dev expWad reverts at or above this input.
    uint256 internal constant EXP_MAX = 135305999368893231589;
    /// @dev expWad(-x) returns 0 at or beyond this x (used by the pow helpers).
    uint256 internal constant EXP_ZERO = 41446531673892822313;

    error TradeTooLarge();
    error InsufficientReserve();
    error BadParams();

    // ---------------------------------------------------------------------------------------------
    // Fills. k is k_buy for buys and k_sell for sells (see `slopes`). p is the match boundary or 0.
    // ---------------------------------------------------------------------------------------------

    /// @notice Quote in -> coin out, rounded down.
    function buyExactIn(uint256 u0, uint256 v0, uint256 k, uint256 p, uint256 quoteIn)
        internal
        pure
        returns (uint256)
    {
        if (quoteIn == 0) return 0;
        uint256 ub = u0;
        uint256 vb = v0;
        if (p != 0) {
            (uint256 ub2, uint256 vb2) = boundPoint(u0, v0, k, p);
            if (v0 < vb2) {
                // Below the floor: straight line at price p until the curve's ask reaches p.
                if (quoteIn <= vb2 - v0) return Math.mulDiv(quoteIn, Q128, p);
                (ub, vb) = (ub2, vb2);
            }
        }
        uint256 u1 = _decayUp(ub, v0 + quoteIn, vb, WAD, k);
        return u1 < u0 ? u0 - u1 : 0;
    }

    /// @notice Coin out -> quote in, rounded up.
    function buyExactOut(uint256 u0, uint256 v0, uint256 k, uint256 p, uint256 coinOut)
        internal
        pure
        returns (uint256)
    {
        if (coinOut == 0) return 0;
        if (coinOut >= u0) revert InsufficientReserve();
        uint256 ub = u0;
        uint256 vb = v0;
        if (p != 0) {
            (uint256 ub2, uint256 vb2) = boundPoint(u0, v0, k, p);
            if (v0 < vb2) {
                if (ub2 < u0 && coinOut <= u0 - ub2) return Math.mulDiv(coinOut, p, Q128, Math.Rounding.Ceil);
                (ub, vb) = (ub2, vb2);
            }
        }
        uint256 v1 = _growUp(vb, ub, u0 - coinOut, k, WAD);
        return v1 - v0;
    }

    /// @notice Coin in -> quote out, rounded down.
    function sellExactIn(uint256 u0, uint256 v0, uint256 k, uint256 p, uint256 coinIn)
        internal
        pure
        returns (uint256)
    {
        if (coinIn == 0) return 0;
        uint256 ub = u0;
        uint256 vb = v0;
        if (p != 0) {
            (uint256 ub2, uint256 vb2) = boundPoint(u0, v0, k, p);
            if (v0 > vb2) {
                // Above the ceiling: straight line at price p until the curve's bid falls to p.
                if (coinIn <= ub2 - u0) return Math.mulDiv(coinIn, p, Q128);
                (ub, vb) = (ub2, vb2);
            }
        }
        uint256 v1 = _decayUp(vb, u0 + coinIn, ub, k, WAD);
        return v1 < v0 ? v0 - v1 : 0;
    }

    /// @notice Quote out -> coin in, rounded up.
    function sellExactOut(uint256 u0, uint256 v0, uint256 k, uint256 p, uint256 quoteOut)
        internal
        pure
        returns (uint256)
    {
        if (quoteOut == 0) return 0;
        if (quoteOut >= v0) revert InsufficientReserve();
        uint256 ub = u0;
        uint256 vb = v0;
        if (p != 0) {
            (uint256 ub2, uint256 vb2) = boundPoint(u0, v0, k, p);
            if (v0 > vb2) {
                if (quoteOut <= v0 - vb2) return Math.mulDiv(quoteOut, Q128, p, Math.Rounding.Ceil);
                (ub, vb) = (ub2, vb2);
            }
        }
        uint256 u1 = _growUp(ub, vb, v0 - quoteOut, WAD, k);
        return u1 - u0;
    }

    /// @notice Where the line v + p*u = const through (u0, v0) meets the curve's marginal price k*v/u = p.
    ///         Both coordinates are rounded up, which moves every later pow in the pool's favour.
    function boundPoint(uint256 u0, uint256 v0, uint256 k, uint256 p) internal pure returns (uint256 ub, uint256 vb) {
        uint256 kConst = v0 + Math.mulDiv(p, u0, Q128, Math.Rounding.Ceil);
        vb = Math.mulDiv(kConst, WAD, WAD + k, Math.Rounding.Ceil);
        ub = Math.mulDiv(Math.mulDiv(vb, k, WAD, Math.Rounding.Ceil), Q128, p, Math.Rounding.Ceil);
    }

    // ---------------------------------------------------------------------------------------------
    // Pricing inputs
    // ---------------------------------------------------------------------------------------------

    /// @notice H = 1 + h0 * (1 - elapsed / tau) for elapsed < tau, else 1. WAD, rounded up (linear fade).
    ///         h0 == 0 turns the premium off.
    function premium(uint256 h0, uint256 tau, uint256 elapsed) internal pure returns (uint256) {
        if (h0 == 0) return WAD;
        if (tau == 0) revert BadParams();
        if (elapsed >= tau) return WAD;
        return WAD + Math.mulDiv(h0, tau - elapsed, tau, Math.Rounding.Ceil);
    }

    /// @notice G = H / (1 - f), WAD, rounded up. Fee in pips.
    function markup(uint256 h, uint256 fee) internal pure returns (uint256) {
        if (fee >= FEE_DENOM) revert BadParams();
        return Math.mulDiv(h, FEE_DENOM, FEE_DENOM - fee, Math.Rounding.Ceil);
    }

    /// @notice Curve slopes from the anchor P_ref and seed ratio T (both X128) and per-side markups.
    ///         kBuy = C * gBuy rounded up (higher ask); kSell = C / gSell rounded down (lower bid).
    ///         Pass the same markup twice for a symmetric spread. The hook passes the lag premium on one side only.
    function slopes(uint256 pRefX128, uint256 tX128, uint256 gBuy, uint256 gSell)
        internal
        pure
        returns (uint256 kBuy, uint256 kSell)
    {
        if (pRefX128 == 0 || tX128 == 0 || gBuy < WAD || gSell < WAD) revert BadParams();
        kBuy = Math.mulDiv(pRefX128, gBuy, tX128, Math.Rounding.Ceil);
        kSell = Math.mulDiv(Math.mulDiv(pRefX128, WAD, tX128), WAD, gSell);
        if (kSell == 0) revert BadParams();
    }

    /// @notice Match boundary from the source's live quotes: ask floor = source ask * (1 - edge), rounded up;
    ///         bid ceiling = source bid * (1 + edge), rounded down. X128.
    function matchBounds(uint256 srcAskX128, uint256 srcBidX128, uint256 edgeBps)
        internal
        pure
        returns (uint256 askFloor, uint256 bidCeil)
    {
        if (edgeBps >= BPS) revert BadParams();
        askFloor = Math.mulDiv(srcAskX128, BPS - edgeBps, BPS, Math.Rounding.Ceil);
        bidCeil = Math.mulDiv(srcBidX128, BPS + edgeBps, BPS);
    }

    /// @notice True when `price` has moved at least `bps` from `ref` (the premium reset trigger).
    function movedBeyond(uint256 ref, uint256 price, uint256 bps) internal pure returns (bool) {
        if (ref == 0) return true;
        uint256 d = price > ref ? price - ref : ref - price;
        return Math.mulDiv(d, BPS, ref) >= bps;
    }

    // ---------------------------------------------------------------------------------------------
    // Pow helpers. Both return the remaining reserve, rounded up (against the trader).
    // ---------------------------------------------------------------------------------------------

    /// @dev base * (den/num)^(cN/cD), num >= den > 0.
    function _decayUp(uint256 base, uint256 num, uint256 den, uint256 cN, uint256 cD) private pure returns (uint256) {
        uint256 ratio = Math.mulDiv(num, WAD, den); // floor -> smaller ln -> larger remainder
        if (ratio <= WAD) return base;
        if (ratio > uint256(type(int256).max)) revert TradeTooLarge();
        int256 ln = FPM.lnWad(int256(ratio)) - int256(LN_SLACK);
        if (ln <= 0) return base;
        uint256 x = Math.mulDiv(uint256(ln), cN, cD);
        uint256 e = (x >= EXP_ZERO ? 0 : uint256(FPM.expWad(-int256(x)))) + EXP_SLACK;
        if (e >= WAD) return base;
        return Math.mulDiv(base, e, WAD, Math.Rounding.Ceil);
    }

    /// @dev base * (num/den)^(cN/cD), num >= den > 0.
    function _growUp(uint256 base, uint256 num, uint256 den, uint256 cN, uint256 cD) private pure returns (uint256) {
        uint256 ratio = Math.mulDiv(num, WAD, den, Math.Rounding.Ceil);
        if (ratio > uint256(type(int256).max)) revert TradeTooLarge();
        int256 ln = FPM.lnWad(int256(ratio));
        uint256 y = Math.mulDiv((ln > 0 ? uint256(ln) : 0) + LN_SLACK, cN, cD, Math.Rounding.Ceil);
        if (y >= EXP_MAX) revert TradeTooLarge();
        uint256 e = uint256(FPM.expWad(int256(y)));
        e += e / 1e17 + EXP_SLACK;
        return Math.mulDiv(base, e, WAD, Math.Rounding.Ceil);
    }
}

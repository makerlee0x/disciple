// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";
import {BridgeCurve} from "./BridgeCurve.sol";

/// @title Disciple's exact-in arb size against the anchor
/// @notice Picks the buy or the sell that maximizes mark-to-anchor profit after the hook's real fee.
///         Amounts are 18-dec normalized. The hook floors them to raw units before returning.
library BridgeArb {
    struct Quote {
        bool buyCoin;
        uint256 amountIn;
        uint256 amountOut;
        uint256 profitWad;
    }

    /// @dev `buyCoin` is set from the side of the anchor even when no size has positive profit.
    function quote(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx) internal pure returns (Quote memory q) {
        if (s.anchor == 0) return q;
        uint256 spotP = BridgeCurve.spot(s);
        if (spotP == 0 || spotP == s.anchor) return q;
        q.buyCoin = spotP < s.anchor;
        if (q.buyCoin) {
            uint256 hi = _maxBuyIn(s);
            (q.amountIn, q.amountOut, q.profitWad) = _best(s, ctx, hi, true);
        } else {
            uint256 hi = _maxSellIn(s, ctx);
            (q.amountIn, q.amountOut, q.profitWad) = _best(s, ctx, hi, false);
        }
        if (q.profitWad == 0) {
            q.amountIn = 0;
            q.amountOut = 0;
        }
    }

    /// @dev The rev fee steps with size, so a one-wei derivative walk can stop on a rounding
    ///      wiggle far below the peak. A doubling grid finds the right octave. A ternary search
    ///      inside that octave settles the size. The result has to beat half of itself.
    function _best(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 hi, bool buy)
        private
        pure
        returns (uint256 bestIn, uint256 bestOut, uint256 bestP)
    {
        if (hi == 0) return (0, 0, 0);
        uint256 probe = hi < 1e15 ? hi : 1e15;
        uint256 prev;
        while (probe != 0 && probe != prev) {
            (uint256 p, uint256 out) = _profit(s, ctx, probe, buy);
            if (p > bestP) {
                bestP = p;
                bestOut = out;
                bestIn = probe;
            }
            if (probe == hi) break;
            prev = probe;
            probe = probe > hi / 2 ? hi : probe * 2;
        }
        if (bestIn < 2) return (bestIn, bestOut, bestP);
        uint256 lo = bestIn >> 1;
        uint256 right = bestIn > hi / 2 ? hi : bestIn << 1;
        if (lo == 0) lo = 1;
        for (uint256 i; i < 24 && lo + 1 < right; ++i) {
            uint256 span = right - lo;
            uint256 m1 = lo + span / 3;
            uint256 m2 = right - span / 3;
            if (m1 == 0 || m2 == 0 || m1 == m2) break;
            (uint256 p1,) = _profit(s, ctx, m1, buy);
            (uint256 p2,) = _profit(s, ctx, m2, buy);
            if (p1 < p2) lo = m1;
            else right = m2;
        }
        (uint256 pLo, uint256 outLo) = _profit(s, ctx, lo, buy);
        if (pLo > bestP) {
            bestP = pLo;
            bestOut = outLo;
            bestIn = lo;
        }
        (uint256 pRight, uint256 outRight) = _profit(s, ctx, right, buy);
        if (pRight > bestP) {
            bestP = pRight;
            bestOut = outRight;
            bestIn = right;
        }
        for (uint256 i; i < 6 && bestIn > 1; ++i) {
            uint256 half = bestIn >> 1;
            (uint256 halfP, uint256 halfOut) = _profit(s, ctx, half, buy);
            if (halfP <= bestP) break;
            bestP = halfP;
            bestOut = halfOut;
            bestIn = half;
        }
    }

    /// @dev Largest gross USDG a buy can spend without crossing the seed guard.
    function _maxBuyIn(BridgeCurve.S memory s) private pure returns (uint256) {
        uint256 dxCap = BridgeCurve.maxCoinOut(s);
        if (dxCap == 0) return 0;
        uint256 net = BridgeCurve.buyCost(s, dxCap);
        // The progress fee never exceeds FEE_TINY_BPS, so this gross is a safe search ceiling.
        if (C.FEE_TINY_BPS >= C.BPS) return net;
        return Math.mulDiv(net, C.BPS, C.BPS - C.FEE_TINY_BPS, Math.Rounding.Ceil);
    }

    function _maxSellIn(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx) private pure returns (uint256) {
        if (s.x <= 1) return 0;
        BridgeCurve.S memory c = _clone(s);
        (, BridgeCurve.Fill memory f) = BridgeCurve.sellExactIn(c, s.x - 1, ctx);
        return f.coinIn;
    }

    /// @dev Profit is zero when the fill is capped or does not consume the requested input,
    ///      so the search never returns a size `beforeSwap` would reject.
    function _profit(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, bool buy)
        private
        pure
        returns (uint256 profit, uint256 amountOut)
    {
        if (amount == 0) return (0, 0);
        BridgeCurve.S memory c = _clone(s);
        if (buy) {
            (, BridgeCurve.Fill memory f) = BridgeCurve.buyExactIn(c, amount, ctx);
            if (f.capped || f.usdgIn != amount || f.coinOut == 0) return (0, 0);
            uint256 mark = Math.mulDiv(f.coinOut, s.anchor, C.WAD);
            if (mark <= f.usdgIn) return (0, f.coinOut);
            return (mark - f.usdgIn, f.coinOut);
        }
        (, BridgeCurve.Fill memory sold) = BridgeCurve.sellExactIn(c, amount, ctx);
        if (sold.capped || sold.coinIn != amount || sold.usdgOut == 0) return (0, 0);
        uint256 cost = Math.mulDiv(sold.coinIn, s.anchor, C.WAD);
        if (sold.usdgOut <= cost) return (0, sold.usdgOut);
        return (sold.usdgOut - cost, sold.usdgOut);
    }

    function _clone(BridgeCurve.S memory s) private pure returns (BridgeCurve.S memory c) {
        c.x = s.x;
        c.y = s.y;
        c.vx = s.vx;
        c.vy = s.vy;
        c.anchor = s.anchor;
        c.seedFloor = s.seedFloor;
        c.discountWad = s.discountWad;
        c.depthUsd = s.depthUsd;
        c.feePot = s.feePot;
        c.lockedY = s.lockedY;
        c.protoX = s.protoX;
        c.protoY = s.protoY;
        c.lpX = s.lpX;
        c.lpY = s.lpY;
        c.initialSeed = s.initialSeed;
    }
}

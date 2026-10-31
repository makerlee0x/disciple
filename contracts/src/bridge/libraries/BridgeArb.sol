// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";
import {BridgeCurve} from "./BridgeCurve.sol";

/// @title Exact-in arb size against the anchor
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

    function _best(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 hi, bool buy)
        private
        pure
        returns (uint256 bestIn, uint256 bestOut, uint256 bestP)
    {
        if (hi == 0) return (0, 0, 0);
        uint256 lo;
        uint256 right = hi;
        while (lo + 1 < right) {
            uint256 mid = (lo + right) >> 1;
            (uint256 pMid,) = _profit(s, ctx, mid, buy);
            (uint256 pNext,) = _profit(s, ctx, mid + 1, buy);
            if (pNext > pMid) lo = mid + 1;
            else right = mid;
        }
        (bestP, bestOut) = _profit(s, ctx, lo, buy);
        bestIn = bestP == 0 ? 0 : lo;
        (uint256 pRight, uint256 outRight) = _profit(s, ctx, right, buy);
        if (pRight > bestP) {
            bestP = pRight;
            bestOut = outRight;
            bestIn = right;
        }
        if (right < hi) {
            (uint256 pHi, uint256 outHi) = _profit(s, ctx, hi, buy);
            if (pHi > bestP) {
                bestP = pHi;
                bestOut = outHi;
                bestIn = hi;
            }
        }
    }

    /// @dev Largest gross USDG a buy can spend without crossing the seed guard.
    function _maxBuyIn(BridgeCurve.S memory s) private pure returns (uint256) {
        uint256 dxCap = BridgeCurve.maxCoinOut(s);
        if (dxCap == 0) return 0;
        uint256 net = BridgeCurve.buyCost(s, dxCap);
        // Fees are at most FEE_ABS_CAP_BPS, so this gross is a safe search ceiling.
        if (C.FEE_ABS_CAP_BPS >= C.BPS) return net;
        return Math.mulDiv(net, C.BPS, C.BPS - C.FEE_ABS_CAP_BPS, Math.Rounding.Ceil);
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
        c.protoX = s.protoX;
        c.protoY = s.protoY;
        c.lpX = s.lpX;
        c.lpY = s.lpY;
        c.initialSeed = s.initialSeed;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeArb} from "./libraries/BridgeArb.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";

/// @title Fixed curve, Dutch, and fee library
/// @notice Pure math. No state and no token custody. Linked into the hook. The address is baked into
///         the hook bytecode and cannot be replaced.
library DiscipleMath {
    function init(uint256 coin, uint256 discountWad) public pure returns (BridgeCurve.S memory s) {
        BridgeCurve.init(s, coin, discountWad);
    }

    function onAnchor(BridgeCurve.S memory s, uint256 price) public pure returns (BridgeCurve.S memory) {
        BridgeCurve.onAnchor(s, price);
        return s;
    }

    function addLiquidity(BridgeCurve.S memory s, uint256 dx, uint256 dy) public pure returns (BridgeCurve.S memory) {
        BridgeCurve.addLiquidity(s, dx, dy);
        return s;
    }

    function retarget(BridgeCurve.S memory s, uint256 targetSpot) public pure returns (BridgeCurve.S memory) {
        BridgeCurve.retarget(s, targetSpot);
        return s;
    }

    function spotOf(BridgeCurve.S memory s) public pure returns (uint256) {
        return BridgeCurve.spot(s);
    }

    function tvlOf(BridgeCurve.S memory s) public pure returns (uint256) {
        return BridgeCurve.tvl(s);
    }

    function principalOf(BridgeCurve.S memory s) public pure returns (uint256) {
        return BridgeCurve.principalY(s);
    }

    /// @dev Spot, floor room, principal, the TVL the fee uses, and the LP boost. One call so the book
    ///      encodes the curve once.
    function measures(BridgeCurve.S memory s, uint256 floorAmt, bool graduated, uint256 target)
        public
        pure
        returns (uint256 spotPx, uint256 room, uint256 principal, uint256 bookTvl, uint256 boost)
    {
        spotPx = BridgeCurve.spot(s);
        principal = BridgeCurve.principalY(s);
        room = BridgeCurve.floorRoomAbs(s, floorAmt);
        bookTvl = graduated ? BridgeCurve.lpValue(s) : BridgeCurve.tvl(s);
        boost = BridgeFee.boostWad(bookTvl, target);
    }

    function trade(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, bool sellCoin, uint256 gap)
        public
        pure
        returns (BridgeCurve.S memory, BridgeCurve.Fill memory)
    {
        return _trade(s, ctx, amount, sellCoin, gap);
    }

    function preview(uint256 anchor, uint256 tvl, uint256 gradTvl, uint256 bidGap, uint256 askGap)
        public
        pure
        returns (uint256 bid, uint256 ask, uint256 bidUsdg, uint256 askUsdg)
    {
        (bid, bidUsdg) = _side(anchor, tvl, gradTvl, bidGap, true);
        (ask, askUsdg) = _side(anchor, tvl, gradTvl, askGap, false);
    }

    function quote(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 bidGap, uint256 askGap)
        public
        pure
        returns (bool buyCoin, uint256 amountIn, uint256 amountOut, uint256 profitWad)
    {
        if ((bidGap == 0 && askGap == 0) || s.anchor == 0) {
            if (s.anchor == 0) return (true, 0, 0, 0);
            BridgeArb.Quote memory q = BridgeArb.quote(s, ctx);
            return (q.buyCoin, q.amountIn, q.amountOut, q.profitWad);
        }
        uint256 bestP;
        bool bestBuy = true;
        uint256 bestIn;
        uint256 bestOut;
        uint256 tvl = BridgeCurve.tvl(s);
        if (askGap > 0) {
            (, uint256 askUsdg) = _side(s.anchor, tvl, ctx.gradTvl, askGap, false);
            if (askUsdg > 0) (bestP, bestIn, bestOut) = _markBuy(s, ctx, askUsdg, askGap);
        }
        if (bidGap > 0) {
            (uint256 bid, uint256 bidUsdg) = _side(s.anchor, tvl, ctx.gradTvl, bidGap, true);
            if (bid > 0 && bidUsdg > 0) {
                uint256 maxCoin = Math.mulDiv(bidUsdg, C.WAD, bid);
                (uint256 pft, uint256 inn, uint256 out) = _markSell(s, ctx, maxCoin, bidGap);
                if (pft > bestP) {
                    bestP = pft;
                    bestIn = inn;
                    bestOut = out;
                    bestBuy = false;
                }
            }
        }
        BridgeArb.Quote memory curve = BridgeArb.quote(s, ctx);
        if (curve.amountIn > 0 && curve.profitWad > bestP) {
            if (curve.buyCoin) {
                (uint256 pft, uint256 inn, uint256 out) = _markBuy(s, ctx, curve.amountIn, askGap);
                if (pft > bestP) return (true, inn, out, pft);
            } else {
                (uint256 pft, uint256 inn, uint256 out) = _markSell(s, ctx, curve.amountIn, bidGap);
                if (pft > bestP) return (false, inn, out, pft);
            }
        }
        return (bestBuy, bestIn, bestOut, bestP);
    }

    function fill(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, bool buyCoin, uint256 gap)
        public
        pure
        returns (uint256 amountOut, uint256 profitWad)
    {
        if (amount == 0) return (0, 0);
        if (buyCoin) (profitWad,, amountOut) = _markBuy(s, ctx, amount, gap);
        else (profitWad,, amountOut) = _markSell(s, ctx, amount, gap);
    }

    function decayed(uint256 amount, uint256 dt, uint256 halfLife) public pure returns (uint256) {
        return BridgeFee.decayed(amount, dt, halfLife);
    }

    /// @dev Status flips in this call. `target == 0` is below the line, so a graduated pool drops out
    ///      and the arb fee comes back on. `edge` is 1 on the way up and 2 on the way down.
    function stepGrad(uint256 poolTvl, uint256 target, bool graduated) public pure returns (bool newGrad, uint8 edge) {
        bool over = target != 0 && poolTvl >= target;
        if (over == graduated) return (graduated, 0);
        return (over, over ? 1 : 2);
    }

    /// @dev Before graduation the whole fee is the LP share. While graduated: 3,333 creator, 3,333
    ///      locked, remainder LPs.
    function splitFee(uint256 fee, bool graduated) public pure returns (uint256 creator, uint256 lp, uint256 locked) {
        if (!graduated || fee == 0) return (0, fee, 0);
        creator = Math.mulDiv(fee, C.FEE_CREATOR_BPS, C.BPS);
        locked = Math.mulDiv(fee, C.FEE_LOCKED_BPS, C.BPS);
        lp = fee - creator - locked;
    }

    function feeBps(uint256 tvl, uint256 gradTvl) public pure returns (uint256) {
        return BridgeFee.baseFeeBps(tvl, gradTvl);
    }

    /// @dev Both gaps accrue from the same timestamp, then cap at 77%.
    function accrueGap(uint256 gap, uint64 at, uint256 nowTs) public pure returns (uint256) {
        if (gap > C.DUTCH_GAP_CAP) gap = C.DUTCH_GAP_CAP;
        if (at == 0 || nowTs <= uint256(at)) return gap;
        uint256 add = (nowTs - uint256(at)) * C.DUTCH_RATE;
        if (add >= C.DUTCH_GAP_CAP || gap >= C.DUTCH_GAP_CAP - add) return C.DUTCH_GAP_CAP;
        return gap + add;
    }

    /// @dev Linear consumption against pool depth. A clip at least as large as `depth` ends at zero.
    ///      The average is the value-weighted gap the fill is quoted at. Splitting sees a smaller gap.
    function consumeGap(uint256 gap, uint256 q, uint256 depth) public pure returns (uint256 avg, uint256 endGap) {
        if (gap == 0 || q == 0) return (0, gap);
        if (depth == 0 || q >= depth) {
            if (depth == 0) return (0, 0);
            return (Math.mulDiv(gap, depth, q * 2), 0);
        }
        endGap = Math.mulDiv(gap, depth - q, depth);
        avg = (gap + endGap) / 2;
    }

    /// @dev Accrue, consume the side this fill takes, and restart the other side at zero.
    function advanceDutch(uint256 bid, uint256 ask, uint64 at, uint256 q, uint256 depth, bool sellCoin, uint256 nowTs)
        public
        pure
        returns (uint256 newBid, uint256 newAsk, uint64 newAt, uint256 avg)
    {
        bid = accrueGap(bid, at, nowTs);
        ask = accrueGap(ask, at, nowTs);
        if (sellCoin) (avg, bid) = consumeGap(bid, q, depth);
        else (avg, ask) = consumeGap(ask, q, depth);
        if (sellCoin) ask = 0;
        else bid = 0;
        newBid = bid;
        newAsk = ask;
        newAt = uint64(nowTs == 0 ? 1 : nowTs);
    }

    function _trade(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, bool sellCoin, uint256 gap)
        private
        pure
        returns (BridgeCurve.S memory, BridgeCurve.Fill memory)
    {
        BridgeCurve.Ctx memory local = _copy(ctx);
        uint256 lVal = local.useOpen ? local.openLpVal : BridgeCurve.lpValue(s);
        uint256 pVal = BridgeCurve.protoValue(s);
        uint256 shares = local.useOpen ? local.openShares : local.totalShares;
        BridgeCurve.S memory out;
        BridgeCurve.Fill memory f;
        if (amount == 0 || s.anchor == 0) {
            if (sellCoin) (out, f) = BridgeCurve.sellExactIn(s, amount, local);
            else (out, f) = BridgeCurve.buyExactIn(s, amount, local);
            return _arb(out, f, local, sellCoin, lVal, pVal, shares);
        }
        uint256 resting = BridgeCurve.spot(s);
        if (resting == 0) resting = s.anchor;
        uint256 px = _dutchPrice(s.anchor, gap, sellCoin);
        bool better = sellCoin ? px > resting : (px != 0 && px < resting);
        if (!better || gap == 0) {
            if (sellCoin) (out, f) = BridgeCurve.sellExactIn(s, amount, local);
            else (out, f) = BridgeCurve.buyExactIn(s, amount, local);
            return _arb(out, f, local, sellCoin, lVal, pVal, shares);
        }
        // The whole clip is quoted at the average Dutch price, then the book is put back on the
        // resting spot. Gap consumption, not a slice cap, is what stops a repeated fill.
        BridgeCurve.S memory book = BridgeCurve.clone(s);
        BridgeCurve.retarget(book, px);
        if (sellCoin) (book, f) = BridgeCurve.sellExactIn(book, amount, local);
        else (book, f) = BridgeCurve.buyExactIn(book, amount, local);
        bool filled = sellCoin ? f.coinIn == amount && f.usdgOut != 0 : f.usdgIn == amount && f.coinOut != 0;
        if (f.capped || !filled) {
            if (sellCoin) (out, f) = BridgeCurve.sellExactIn(s, amount, local);
            else (out, f) = BridgeCurve.buyExactIn(s, amount, local);
            return _arb(out, f, local, sellCoin, lVal, pVal, shares);
        }
        BridgeCurve.retarget(book, resting);
        f.spotAfter = BridgeCurve.spot(book);
        return _arb(book, f, local, sellCoin, lVal, pVal, shares);
    }

    /// @dev Arb fee is 77% of the improvement left after the sliding fee. It is not charged while
    ///      graduated. The arb portion cannot exceed the improvement. It is not capped against the
    ///      sliding fee, so the two together can be larger than the improvement.
    function _arb(
        BridgeCurve.S memory s,
        BridgeCurve.Fill memory f,
        BridgeCurve.Ctx memory ctx,
        bool sellCoin,
        uint256 lVal,
        uint256 pVal,
        uint256 shares
    ) private pure returns (BridgeCurve.S memory, BridgeCurve.Fill memory) {
        if (ctx.graduated || s.anchor == 0) return (s, f);
        if (!sellCoin) {
            if (f.coinOut == 0 || f.usdgIn == 0) return (s, f);
            uint256 mark = Math.mulDiv(f.coinOut, s.anchor, C.WAD);
            if (mark <= f.usdgIn) return (s, f);
            uint256 arb = Math.mulDiv(mark - f.usdgIn, C.ARB_FEE_BPS, C.BPS);
            if (arb == 0) return (s, f);
            uint256 coins = Math.mulDiv(arb, C.WAD, s.anchor);
            if (coins > f.coinOut) coins = f.coinOut;
            if (coins == 0) return (s, f);
            f.coinOut -= coins;
            f.arb = arb;
            BridgeCurve.creditCoin(s, coins, lVal, pVal, ctx.boostWad, shares);
            return (s, f);
        }
        if (f.usdgOut == 0 || f.coinIn == 0) return (s, f);
        uint256 cost = Math.mulDiv(f.coinIn, s.anchor, C.WAD);
        if (f.usdgOut <= cost) return (s, f);
        uint256 sellArb = Math.mulDiv(f.usdgOut - cost, C.ARB_FEE_BPS, C.BPS);
        if (sellArb > f.usdgOut) sellArb = f.usdgOut;
        if (sellArb == 0) return (s, f);
        f.usdgOut -= sellArb;
        f.arb = sellArb;
        f.toLp += BridgeCurve.compound(s, sellArb, lVal, pVal, ctx.boostWad, shares);
        return (s, f);
    }

    function _dutchPrice(uint256 anchor, uint256 gap, bool sellCoin) private pure returns (uint256) {
        if (anchor == 0 || gap == 0) return anchor;
        if (gap > C.DUTCH_GAP_CAP) gap = C.DUTCH_GAP_CAP;
        if (sellCoin) return Math.mulDiv(anchor, C.WAD + gap, C.WAD);
        return Math.mulDiv(anchor, C.WAD - gap, C.WAD);
    }

    function _markBuy(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, uint256 gap)
        private
        pure
        returns (uint256 profitWad, uint256 amountIn, uint256 amountOut)
    {
        (, BridgeCurve.Fill memory f) = _trade(s, ctx, amount, false, gap);
        if (f.capped || f.usdgIn != amount || f.coinOut == 0) return (0, 0, 0);
        uint256 mark = Math.mulDiv(f.coinOut, s.anchor, C.WAD);
        if (mark <= f.usdgIn) return (0, 0, 0);
        return (mark - f.usdgIn, f.usdgIn, f.coinOut);
    }

    function _markSell(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, uint256 gap)
        private
        pure
        returns (uint256 profitWad, uint256 amountIn, uint256 amountOut)
    {
        (, BridgeCurve.Fill memory f) = _trade(s, ctx, amount, true, gap);
        if (f.capped || f.coinIn != amount || f.usdgOut == 0) return (0, 0, 0);
        uint256 cost = Math.mulDiv(f.coinIn, s.anchor, C.WAD);
        if (f.usdgOut <= cost) return (0, 0, 0);
        return (f.usdgOut - cost, f.coinIn, f.usdgOut);
    }

    /// @dev Price at the accrued gap. `usdg` is the depth that would consume the gap, not a slice cap.
    function _side(uint256 anchor, uint256 tvl, uint256, uint256 gap, bool bid)
        private
        pure
        returns (uint256 price, uint256 usdg)
    {
        if (anchor == 0 || gap == 0) return (anchor, 0);
        if (gap > C.DUTCH_GAP_CAP) gap = C.DUTCH_GAP_CAP;
        if (bid) price = Math.mulDiv(anchor, C.WAD + gap, C.WAD);
        else price = Math.mulDiv(anchor, C.WAD - gap, C.WAD);
        usdg = tvl;
    }

    function _copy(BridgeCurve.Ctx memory c) private pure returns (BridgeCurve.Ctx memory o) {
        o.gradTvl = c.gradTvl;
        o.graduated = c.graduated;
        o.floorBps = c.floorBps;
        o.principalFloor = c.principalFloor;
        o.maxUsdgOut = c.maxUsdgOut;
        o.totalShares = c.totalShares;
        o.useOpen = c.useOpen;
        o.openLpVal = c.openLpVal;
        o.openShares = c.openShares;
        o.boostWad = c.boostWad;
    }
}

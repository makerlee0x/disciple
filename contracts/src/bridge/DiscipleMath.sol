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

    function stepGrad(
        uint256 poolTvl,
        uint256 target,
        bool graduated,
        uint64 aboveSince,
        uint64 belowSince,
        uint256 timestamp
    ) public pure returns (bool newGrad, uint64 newAbove, uint64 newBelow, uint8 edge) {
        uint256 nowTs = timestamp == 0 ? 1 : timestamp;
        newGrad = graduated;
        newAbove = aboveSince;
        newBelow = belowSince;
        uint256 wait = C.GRADUATION_WINDOW;
        bool over = target != 0 && poolTvl >= target;
        if (!newGrad) {
            if (!over) {
                newAbove = 0;
                return (newGrad, newAbove, newBelow, 0);
            }
            if (newAbove == 0) {
                newAbove = uint64(nowTs);
                return (newGrad, newAbove, newBelow, 0);
            }
            if (nowTs >= uint256(newAbove) + wait) {
                newGrad = true;
                newBelow = 0;
                edge = 1;
            }
            return (newGrad, newAbove, newBelow, edge);
        }
        if (over) {
            newBelow = 0;
            return (newGrad, newAbove, newBelow, 0);
        }
        if (newBelow == 0) {
            newBelow = uint64(nowTs);
            return (newGrad, newAbove, newBelow, 0);
        }
        if (nowTs >= uint256(newBelow) + wait) {
            newGrad = false;
            newAbove = 0;
            newBelow = 0;
            edge = 2;
        }
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

    /// @dev 0 input selects the default. 0 output means the value is outside the allowed range.
    function normalizeDrift(uint64 dutchDrift) public pure returns (uint64) {
        if (dutchDrift == 0) return uint64(C.DUTCH_DRIFT_DEFAULT);
        if (uint256(dutchDrift) < C.DUTCH_DRIFT_MIN || uint256(dutchDrift) > C.DUTCH_DRIFT_MAX) return 0;
        return dutchDrift;
    }

    function _trade(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, bool sellCoin, uint256 gap)
        private
        pure
        returns (BridgeCurve.S memory, BridgeCurve.Fill memory)
    {
        BridgeCurve.Ctx memory local = _copy(ctx);
        if (amount == 0 || gap == 0 || s.anchor == 0) {
            if (sellCoin) return BridgeCurve.sellExactIn(s, amount, local);
            return BridgeCurve.buyExactIn(s, amount, local);
        }
        uint256 resting = BridgeCurve.spot(s);
        if (resting == 0) resting = s.anchor;
        (uint256 bid, uint256 ask, uint256 bidUsdg, uint256 askUsdg) =
            _sizes(s.anchor, BridgeCurve.tvl(s), ctx.gradTvl, gap);
        if (sellCoin) {
            if (bid <= resting || bidUsdg == 0) return BridgeCurve.sellExactIn(s, amount, local);
            uint256 maxCoin = Math.mulDiv(bidUsdg, C.WAD, bid);
            if (maxCoin == 0) return BridgeCurve.sellExactIn(s, amount, local);
            uint256 slice = amount < maxCoin ? amount : maxCoin;
            BridgeCurve.S memory trial = BridgeCurve.clone(s);
            BridgeCurve.retarget(trial, bid);
            BridgeCurve.Fill memory a;
            (trial, a) = BridgeCurve.sellExactIn(trial, slice, local);
            if (a.capped || a.coinIn != slice || a.usdgOut == 0) return BridgeCurve.sellExactIn(s, amount, local);
            BridgeCurve.retarget(trial, resting);
            a.spotAfter = BridgeCurve.spot(trial);
            if (slice == amount) return (trial, a);
            if (a.usdgOut < local.maxUsdgOut) local.maxUsdgOut -= a.usdgOut;
            else local.maxUsdgOut = 0;
            BridgeCurve.Fill memory b;
            (trial, b) = BridgeCurve.sellExactIn(trial, amount - slice, local);
            return (trial, _merge(a, b));
        }
        if (ask == 0 || ask >= resting || askUsdg == 0) return BridgeCurve.buyExactIn(s, amount, local);
        uint256 buySlice = amount < askUsdg ? amount : askUsdg;
        BridgeCurve.S memory book = BridgeCurve.clone(s);
        BridgeCurve.retarget(book, ask);
        BridgeCurve.Fill memory bought;
        (book, bought) = BridgeCurve.buyExactIn(book, buySlice, local);
        if (bought.capped || bought.usdgIn != buySlice || bought.coinOut == 0) {
            return BridgeCurve.buyExactIn(s, amount, local);
        }
        BridgeCurve.retarget(book, resting);
        bought.spotAfter = BridgeCurve.spot(book);
        if (buySlice == amount) return (book, bought);
        BridgeCurve.Fill memory rest;
        (book, rest) = BridgeCurve.buyExactIn(book, amount - buySlice, local);
        return (book, _merge(bought, rest));
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

    function _sizes(uint256 anchor, uint256 tvl, uint256 gradTvl, uint256 gap)
        private
        pure
        returns (uint256 bid, uint256 ask, uint256 bidUsdg, uint256 askUsdg)
    {
        if (anchor == 0 || gap == 0) return (anchor, anchor, 0, 0);
        bid = Math.mulDiv(anchor, C.WAD + gap, C.WAD);
        uint256 priceGap = gap > C.DUTCH_ASK_CAP ? C.DUTCH_ASK_CAP : gap;
        ask = Math.mulDiv(anchor, C.WAD - priceGap, C.WAD);
        uint256 cap = BridgeFee.dutchCap(tvl, gradTvl);
        uint256 offered = Math.mulDiv(C.DUTCH_EDGE_WAD, C.WAD, gap);
        if (offered > cap) offered = cap;
        bidUsdg = offered;
        askUsdg = offered;
    }

    function _side(uint256 anchor, uint256 tvl, uint256 gradTvl, uint256 gap, bool bid)
        private
        pure
        returns (uint256 price, uint256 usdg)
    {
        if (anchor == 0 || gap == 0) return (anchor, 0);
        if (bid) {
            price = Math.mulDiv(anchor, C.WAD + gap, C.WAD);
        } else {
            uint256 priceGap = gap > C.DUTCH_ASK_CAP ? C.DUTCH_ASK_CAP : gap;
            price = Math.mulDiv(anchor, C.WAD - priceGap, C.WAD);
        }
        uint256 cap = BridgeFee.dutchCap(tvl, gradTvl);
        uint256 offered = Math.mulDiv(C.DUTCH_EDGE_WAD, C.WAD, gap);
        if (offered > cap) offered = cap;
        usdg = offered;
    }

    function _merge(BridgeCurve.Fill memory a, BridgeCurve.Fill memory b)
        private
        pure
        returns (BridgeCurve.Fill memory f)
    {
        f.coinIn = a.coinIn + b.coinIn;
        f.coinOut = a.coinOut + b.coinOut;
        f.usdgIn = a.usdgIn + b.usdgIn;
        f.usdgOut = a.usdgOut + b.usdgOut;
        f.fee = a.fee + b.fee;
        f.creator = a.creator + b.creator;
        f.locked = a.locked + b.locked;
        f.compound = a.compound + b.compound;
        f.toLp = a.toLp + b.toLp;
        f.spotBefore = a.spotBefore;
        f.spotAfter = b.spotAfter == 0 ? a.spotAfter : b.spotAfter;
        f.capped = b.capped;
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

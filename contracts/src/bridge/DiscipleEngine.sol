// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeArb} from "./libraries/BridgeArb.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";

/// @title Disciple curve, Dutch quote, and arb math
/// @notice Stateless quotes for Disciple (`DiscipleHook`). The hook keeps custody and calls here so
///         Disciple deploys under the 24kb limit. This contract holds no tokens, has no admin, and its
///         address is fixed on the hook at construction. Calling it directly only runs the quote.
contract DiscipleEngine {
    function buy(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 usdgGross)
        external
        pure
        returns (BridgeCurve.S memory, BridgeCurve.Fill memory)
    {
        return BridgeCurve.buyExactIn(s, usdgGross, ctx);
    }

    function sell(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 coinIn)
        external
        pure
        returns (BridgeCurve.S memory, BridgeCurve.Fill memory)
    {
        return BridgeCurve.sellExactIn(s, coinIn, ctx);
    }

    /// @notice Exact-in. `gap` is the Dutch gap in WAD (0 trades the curve). A positive gap sells coin
    ///         at `anchor * (1 - gap)` and buys coin at `anchor * (1 + gap)`, for a capped slice, and
    ///         only when that price is better than the resting spot. The remainder, if the slice clears,
    ///         trades the curve after the book is put back on the pre-trade spot. Seed guard, floor,
    ///         and tail still bind inside the curve fill.
    function trade(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, bool sellCoin, uint256 gap)
        external
        pure
        returns (BridgeCurve.S memory, BridgeCurve.Fill memory)
    {
        return _trade(s, ctx, amount, sellCoin, gap);
    }

    /// @notice Bid, ask, and the USDG size of each. Gap 0 returns the anchor and a zero size,
    ///         which means "do not override the curve".
    function preview(uint256 anchor, uint256 tvl, uint256 gap)
        external
        pure
        returns (uint256 bid, uint256 ask, uint256 bidUsdg, uint256 askUsdg)
    {
        return _sizes(anchor, tvl, gap);
    }

    /// @dev Normalized amounts. `buyCoin` is set even when `amountIn` is zero.
    ///      When `gap` is positive the Dutch slice is compared with a curve search re-priced through
    ///      `trade`, so the returned size is one `beforeSwap` would accept.
    function quote(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 gap)
        external
        pure
        returns (bool buyCoin, uint256 amountIn, uint256 amountOut, uint256 profitWad)
    {
        if (gap == 0 || s.anchor == 0) {
            if (s.anchor == 0) return (true, 0, 0, 0);
            BridgeArb.Quote memory q = BridgeArb.quote(s, ctx);
            return (q.buyCoin, q.amountIn, q.amountOut, q.profitWad);
        }
        uint256 bestP;
        bool bestBuy = true;
        uint256 bestIn;
        uint256 bestOut;
        if (gap > 0) {
            (uint256 bid,, uint256 bidUsdg, uint256 askUsdg) = _sizes(s.anchor, BridgeCurve.tvl(s), gap);
            if (askUsdg > 0) {
                (bestP, bestIn, bestOut) = _markBuy(s, ctx, askUsdg, gap);
            }
            if (bid > 0 && bidUsdg > 0) {
                uint256 maxCoin = Math.mulDiv(bidUsdg, C.WAD, bid);
                (uint256 pft, uint256 inn, uint256 out) = _markSell(s, ctx, maxCoin, gap);
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
                (uint256 pft, uint256 inn, uint256 out) = _markBuy(s, ctx, curve.amountIn, gap);
                if (pft > bestP) return (true, inn, out, pft);
            } else {
                (uint256 pft, uint256 inn, uint256 out) = _markSell(s, ctx, curve.amountIn, gap);
                if (pft > bestP) return (false, inn, out, pft);
            }
        }
        return (bestBuy, bestIn, bestOut, bestP);
    }

    /// @dev Profit of one exact-in size through the same path as `trade`. Zero when the fill is capped.
    function fill(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, bool buyCoin, uint256 gap)
        external
        pure
        returns (uint256 amountOut, uint256 profitWad)
    {
        if (amount == 0) return (0, 0);
        if (buyCoin) {
            (profitWad,, amountOut) = _markBuy(s, ctx, amount, gap);
        } else {
            (profitWad,, amountOut) = _markSell(s, ctx, amount, gap);
        }
    }

    /// @dev External so the hook and the LP facet do not inline the decay series into their bytecode.
    function decayed(uint256 amount, uint256 dt, uint256 halfLife) external pure returns (uint256) {
        return BridgeFee.decayed(amount, dt, halfLife);
    }

    /// @dev The progress fee. Same number the curve charges.
    function feeBps(uint256 tvl, uint256 gradTvl) external pure returns (uint256) {
        return BridgeFee.baseFeeBps(tvl, gradTvl);
    }

    /// @dev 0 means the drift is outside the allowed range. 0 input selects the default.
    function normalizeDrift(uint64 dutchDrift) external pure returns (uint64) {
        if (dutchDrift == 0) return uint64(C.DUTCH_DRIFT_DEFAULT);
        if (uint256(dutchDrift) < C.DUTCH_DRIFT_MIN || uint256(dutchDrift) > C.DUTCH_DRIFT_MAX) return 0;
        return dutchDrift;
    }

    /// @dev False when this anchor kind's addresses do not match. The hook reverts `BadCreate`.
    function anchorOk(
        uint8 kind,
        address remoteOracle,
        address v3Pool,
        bytes32 refPoolId,
        address refHook,
        uint256 tipSeed,
        uint32 remoteEid
    ) external pure returns (bool) {
        if (kind == C.ANCHOR_LZ) {
            return remoteOracle != address(0) && v3Pool == address(0) && refPoolId == bytes32(0)
                && refHook == address(0);
        }
        if (kind == C.ANCHOR_V3) {
            return v3Pool != address(0) && tipSeed == 0 && remoteOracle == address(0) && remoteEid == 0
                && refPoolId == bytes32(0) && refHook == address(0);
        }
        if (kind == C.ANCHOR_V4_ORACLE) {
            return refHook != address(0) && refPoolId != bytes32(0) && v3Pool == address(0) && tipSeed == 0
                && remoteOracle == address(0) && remoteEid == 0;
        }
        if (kind == C.ANCHOR_V4_SAMPLE) {
            return refPoolId != bytes32(0) && refHook == address(0) && v3Pool == address(0) && tipSeed == 0
                && remoteOracle == address(0) && remoteEid == 0;
        }
        if (kind == C.ANCHOR_LZ_V4_ORACLE || kind == C.ANCHOR_LZ_V4_SLOT) {
            return remoteOracle != address(0) && refPoolId != bytes32(0) && v3Pool == address(0);
        }
        return false;
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
        (uint256 bid, uint256 ask, uint256 bidUsdg, uint256 askUsdg) = _sizes(s.anchor, BridgeCurve.tvl(s), gap);
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
            if (a.tip < local.tipRoom) local.tipRoom -= a.tip;
            else local.tipRoom = 0;
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
        if (bought.tip < local.tipRoom) local.tipRoom -= bought.tip;
        else local.tipRoom = 0;
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

    function _sizes(uint256 anchor, uint256 tvl, uint256 gap)
        private
        pure
        returns (uint256 bid, uint256 ask, uint256 bidUsdg, uint256 askUsdg)
    {
        if (anchor == 0 || gap == 0) return (anchor, anchor, 0, 0);
        bid = Math.mulDiv(anchor, C.WAD + gap, C.WAD);
        uint256 priceGap = gap > C.DUTCH_ASK_CAP ? C.DUTCH_ASK_CAP : gap;
        ask = Math.mulDiv(anchor, C.WAD - priceGap, C.WAD);
        uint256 cap = tvl / 20;
        if (cap < C.DUTCH_MIN_SLICE) cap = C.DUTCH_MIN_SLICE;
        if (cap > C.DUTCH_MAX_SLICE) cap = C.DUTCH_MAX_SLICE;
        uint256 offered = Math.mulDiv(C.DUTCH_EDGE_WAD, C.WAD, gap);
        if (offered > cap) offered = cap;
        bidUsdg = offered;
        askUsdg = offered;
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
        f.tip = a.tip + b.tip;
        f.creator = a.creator + b.creator;
        f.compound = a.compound + b.compound;
        f.toLp = a.toLp + b.toLp;
        f.spotBefore = a.spotBefore;
        f.spotAfter = b.spotAfter == 0 ? a.spotAfter : b.spotAfter;
        f.capped = b.capped;
    }

    function _copy(BridgeCurve.Ctx memory c) private pure returns (BridgeCurve.Ctx memory o) {
        o.gradTvl = c.gradTvl;
        o.graduated = c.graduated;
        o.tipRoom = c.tipRoom;
        o.floorBps = c.floorBps;
        o.maxUsdgOut = c.maxUsdgOut;
        o.totalShares = c.totalShares;
        o.boostWad = c.boostWad;
        o.quoteFeeSet = c.quoteFeeSet;
        o.quoteFeeBps = c.quoteFeeBps;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";
import {BridgeFee} from "./BridgeFee.sol";

/// @title Anchor-relative virtual-reserve curve with a g^30 tail
/// @notice Reuses the launchpad curve's safety patterns (CurveMath): 1e36 powers, buy cost rounded up,
///         sell proceeds rounded down, Newton/binary search from the safe side, and the audit G-7 clamp
///         (sell proceeds cannot buy the same coins back). The shape is the CP term of curve #1,
///         `price = yEff / xEff`, plus a per-trade `f^30` tail so a fill that tries to empty a side
///         pays sharply more. It is not the launchpad's fixed $3,333→$33,333 market-cap curve — that
///         curve sells a new coin to a graduation mcap. This one quotes an already-issued coin against
///         an Ethereum TWAP.
/// @dev Reserves are 18-dec normalized. `anchor` is normalized USDG per coin, WAD. Virtual reserves
///      (`vx`, `vy`) are not owned by anyone. `feePot` sits inside `y` so fees compound into the price,
///      but sells cannot spend it (LP fee credits stay solvent).
library BridgeCurve {
    struct S {
        uint256 x; // coin reserve (protocol + LP)
        uint256 y; // USDG reserve, includes feePot and USDG sitting in Morpho
        uint256 vx;
        uint256 vy;
        uint256 anchor;
        uint256 seedFloor;
        uint256 discountWad;
        uint256 depthUsd; // high-water TVL; depth never ratchets down
        uint256 feePot;
        uint256 protoX;
        uint256 protoY;
        uint256 lpX;
        uint256 lpY;
        uint256 initialSeed;
    }

    /// @dev Inputs that do not depend on the curve iteration itself.
    struct Ctx {
        uint256 gradTvl; // 0 until the Ethereum TVL has been read
        uint256 age; // seconds since the last good anchor
        bool graduated;
        uint256 tipRoom; // room left under the keeper-budget cap
        uint256 floorBps;
        uint256 maxUsdgOut; // min(floor room, outflow room); type(uint256).max if uncapped by the caller
        uint256 totalShares;
        uint256 boostWad;
    }

    struct Fill {
        uint256 coinIn;
        uint256 coinOut;
        uint256 usdgIn; // gross USDG the buyer pays
        uint256 usdgOut; // net USDG the seller receives
        uint256 fee;
        uint256 tip;
        uint256 creator;
        uint256 compound;
        uint256 toLp; // portion of `compound` credited to the LP fee index
        uint256 spotBefore;
        uint256 spotAfter;
        bool capped; // exact-in could not consume the full amount (seed guard / floor)
    }

    error ZeroSeed();
    error BadDiscount();
    error ZeroAnchor();
    error Insufficient();
    /// @dev USDG added while spot is below the anchor would mint virtual coin and freeze the discount.
    error DiscountDeposit();

    // ───────────────────────────── views ─────────────────────────────

    function spot(S memory s) internal pure returns (uint256) {
        uint256 xE = s.x + s.vx;
        if (xE == 0) return 0;
        return Math.mulDiv(s.y + s.vy, C.WAD, xE);
    }

    /// @notice Coin marked at the anchor, plus USDG. Never the pool's own spot (that would be circular).
    function tvl(S memory s) internal pure returns (uint256) {
        return Math.mulDiv(s.x, s.anchor, C.WAD) + s.y;
    }

    function lpValue(S memory s) internal pure returns (uint256) {
        return s.lpY + Math.mulDiv(s.lpX, s.anchor, C.WAD);
    }

    function protoValue(S memory s) internal pure returns (uint256) {
        return s.protoY + Math.mulDiv(s.protoX, s.anchor, C.WAD);
    }

    function principalY(S memory s) internal pure returns (uint256) {
        return s.protoY + s.lpY;
    }

    /// @notice USDG a sell may remove from principal. `feePot` is senior and is not spendable.
    function floorRoom(S memory s, uint256 floorBps) internal pure returns (uint256) {
        uint256 p = principalY(s);
        uint256 floorAmt = (p * floorBps) / C.BPS;
        return p > floorAmt ? p - floorAmt : 0;
    }

    // ───────────────────────────── lifecycle ─────────────────────────

    function init(S memory s, uint256 coin, uint256 discountWad) internal pure {
        if (coin == 0) revert ZeroSeed();
        if (discountWad == 0 || discountWad > C.WAD / 2) revert BadDiscount(); // at most 50% below
        s.x = coin;
        s.protoX = coin;
        s.initialSeed = coin;
        s.discountWad = discountWad;
        s.seedFloor = Math.mulDiv(coin, C.SEED_FLOOR_BPS, C.BPS);
    }

    /// @notice First call sets spot to `(1 − discount) · anchor`. Later calls keep the same
    ///         spot/anchor ratio (a 10% anchor move moves the quote 10%) and do not touch real reserves.
    function onAnchor(S memory s, uint256 newAnchor) internal pure {
        if (newAnchor == 0) revert ZeroAnchor();
        if (s.anchor == 0) {
            s.anchor = newAnchor;
            uint256 spot0 = Math.mulDiv(newAnchor, C.WAD - s.discountWad, C.WAD);
            _retarget(s, spot0);
            s.depthUsd = tvl(s);
            return;
        }
        uint256 next = Math.mulDiv(spot(s), newAnchor, s.anchor);
        s.anchor = newAnchor;
        _retarget(s, next);
    }

    /// @notice Once spot is at or above the anchor, grow virtual depth with the TVL high-water so the
    ///         quote settles inside ±3.33% by about $10k. Never shallows (a flash deposit cannot flatten
    ///         the book and a later withdrawal cannot re-open the discount).
    function deepen(S memory s) internal pure {
        if (s.anchor == 0) return;
        uint256 p = spot(s);
        if (p < s.anchor) return;
        uint256 v = tvl(s);
        if (v <= s.depthUsd) return;
        uint256 yEff = s.y + s.vy;
        uint256 target = _targetYEff(v);
        if (target > yEff && target > s.y) {
            uint256 xTarget = Math.mulDiv(target, C.WAD, p);
            if (xTarget > s.x) {
                s.vx = xTarget - s.x;
                s.vy = target - s.y;
            }
        }
        s.depthUsd = v;
    }

    /// @dev At FLAT_TVL, yEff ≈ TVL / 3.33% ≈ $300k, so trading the whole pool moves price by ~3.33%.
    ///      Scaled by TVL/FLAT so a $77 pool stays on the shallow launch virtuals.
    function _targetYEff(uint256 v) private pure returns (uint256) {
        uint256 cap = v > C.FLAT_TVL ? C.FLAT_TVL : v;
        return Math.mulDiv(Math.mulDiv(v, C.WAD, C.BAND_WAD), cap, C.FLAT_TVL);
    }

    // ───────────────────────────── quotes ────────────────────────────

    /// @notice Largest coin out. Below the anchor the seed floor binds unless the CP price reaches the
    ///         anchor before that floor (the launch virtuals do: ~18% of the seed, floor is 50%).
    function maxCoinOut(S memory s) internal pure returns (uint256) {
        if (s.anchor == 0 || s.x <= 1) return 0;
        uint256 maxPhys = s.x - 1;
        if (spot(s) >= s.anchor) return maxPhys;
        uint256 room = s.x > s.seedFloor ? s.x - s.seedFloor : 0;
        if (room > maxPhys) room = maxPhys;
        uint256 dxTo = _dxToAnchor(s);
        if (dxTo <= room) return maxPhys;
        return room;
    }

    /// @notice USDG in (ceil) to buy `dx` coin, including the tail. Reverts if `dx` breaks the seed guard.
    function buyCost(S memory s, uint256 dx) internal pure returns (uint256) {
        if (dx == 0) return 0;
        if (dx > maxCoinOut(s)) revert Insufficient();
        uint256 xE = s.x + s.vx;
        uint256 yE = s.y + s.vy;
        if (dx >= xE) revert Insufficient();
        uint256 cp = Math.mulDiv(yE, dx, xE - dx, Math.Rounding.Ceil);
        return cp + _tail(cp, dx, s.x);
    }

    /// @notice Coin out (floor) for an exact net USDG budget.
    function coinOut(S memory s, uint256 usdgNet) internal pure returns (uint256 dx) {
        if (usdgNet == 0) return 0;
        uint256 cap = maxCoinOut(s);
        if (cap == 0) return 0;
        if (buyCost(s, 1) > usdgNet) return 0;
        uint256 lo;
        uint256 hi = cap;
        for (uint256 i; i < C.MAX_NEWTON && lo < hi; ++i) {
            uint256 mid = (lo + hi + 1) >> 1;
            if (buyCost(s, mid) <= usdgNet) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /// @notice Gross USDG out (floor) for selling `dx` coin, before the fee and before the floor cap.
    function sellProceeds(S memory s, uint256 dx) internal pure returns (uint256) {
        if (dx == 0 || s.y == 0) return 0;
        uint256 xE = s.x + s.vx;
        uint256 yE = s.y + s.vy;
        uint256 cp = Math.mulDiv(yE, dx, xE + dx); // floor
        uint256 extra = _tail(cp, dx, s.x + dx);
        if (extra > cp) extra = cp;
        uint256 gross = cp - extra;
        return _g7(s, dx, gross);
    }

    /// @notice Largest coin-in whose gross proceeds are still ≤ `maxGross`.
    function maxSellCoin(S memory s, uint256 maxGross) internal pure returns (uint256) {
        if (maxGross == 0 || s.y == 0) return 0;
        uint256 xE = s.x + s.vx;
        uint256 yE = s.y + s.vy;
        uint256 hi;
        if (yE > maxGross) hi = Math.mulDiv(xE, maxGross, yE - maxGross) + 1;
        else hi = xE == 0 ? 1 : xE;
        uint256 lo;
        for (uint256 i; i < C.MAX_NEWTON && lo < hi; ++i) {
            uint256 mid = (lo + hi + 1) >> 1;
            if (sellProceeds(s, mid) > maxGross) hi = mid - 1;
            else lo = mid;
        }
        return lo;
    }

    // ───────────────────────────── trades ────────────────────────────

    /// @notice Exact-in buy. If `usdgGross` would push past the seed guard, `capped` is set and only the
    ///         guard-sized spend is consumed — callers that must take the full specified amount (v4 swaps)
    ///         should revert on `capped`.
    function buyExactIn(S memory s, uint256 usdgGross, Ctx memory ctx) internal pure returns (S memory, Fill memory f) {
        f.spotBefore = spot(s);
        if (usdgGross == 0 || s.anchor == 0) return (s, f);
        uint256 dxCap = maxCoinOut(s);
        if (dxCap == 0) {
            f.capped = true;
            return (s, f);
        }
        uint256 bps = _bps(s, ctx, f.spotBefore, usdgGross, true, dxCap);
        uint256 fee = Math.mulDiv(usdgGross, bps, C.BPS, Math.Rounding.Ceil);
        if (fee >= usdgGross) fee = usdgGross - 1;
        uint256 net = usdgGross - fee;
        uint256 dx = coinOut(s, net);
        uint256 netMax = buyCost(s, dxCap);
        if (net > netMax) {
            f.capped = true;
            net = netMax;
            dx = dxCap;
            // fee stays on the original gross only for the consumed part
            uint256 grossUsed = _grossFromNet(net, bps);
            fee = grossUsed - net;
            usdgGross = grossUsed;
        }
        if (dx == 0) {
            f.capped = true;
            return (s, f);
        }
        f.coinOut = dx;
        f.usdgIn = usdgGross;
        f.fee = fee;
        _slices(f, ctx);
        uint256 lVal = lpValue(s);
        uint256 pVal = protoValue(s);
        _absorb(s, -_i(dx), _i(net), lVal, pVal);
        f.toLp = _allocate(s, f.compound, lVal, pVal, ctx.boostWad, ctx.totalShares);
        deepen(s);
        f.spotAfter = spot(s);
        return (s, f);
    }

    /// @notice Exact-in sell of `dx` coin. Caps to the floor / outflow via `ctx.maxUsdgOut`.
    function sellExactIn(S memory s, uint256 dx, Ctx memory ctx) internal pure returns (S memory, Fill memory f) {
        f.spotBefore = spot(s);
        if (dx == 0 || s.anchor == 0 || principalY(s) == 0) return (s, f);
        uint256 room = floorRoom(s, ctx.floorBps);
        if (ctx.maxUsdgOut < room) room = ctx.maxUsdgOut;
        uint256 gross = sellProceeds(s, dx);
        if (gross > room) {
            f.capped = true;
            dx = maxSellCoin(s, room);
            gross = dx == 0 ? 0 : sellProceeds(s, dx);
            // The g^30 tail is not monotone, so the search can land a few wei over the room.
            // Never return a size whose proceeds still exceed the room: the hook reverts on
            // `capped`, and a quote must be re-executable.
            uint256 steps;
            while (dx > 0 && gross > room && steps < 32) {
                unchecked {
                    dx -= 1;
                    ++steps;
                }
                gross = sellProceeds(s, dx);
            }
            if (dx == 0 || gross > room) return (s, f);
        }
        if (dx == 0 || gross == 0) {
            f.capped = true;
            return (s, f);
        }
        uint256 spotAfterGuess = _spotAfterSell(s, dx, gross);
        uint256 bps = BridgeFee.applyStale(
            BridgeFee.directional(BridgeFee.baseFeeBps(tvl(s), ctx.gradTvl), f.spotBefore, spotAfterGuess, s.anchor),
            ctx.age
        );
        uint256 fee = Math.mulDiv(gross, bps, C.BPS, Math.Rounding.Ceil);
        if (fee > gross) fee = gross;
        f.coinIn = dx;
        f.fee = fee;
        f.usdgOut = gross - fee;
        _slices(f, ctx);
        // `compound` stays in the pool; the rest of `gross` leaves principal.
        uint256 lVal = lpValue(s);
        uint256 pVal = protoValue(s);
        _absorb(s, _i(dx), -_i(gross), lVal, pVal);
        f.toLp = _allocate(s, f.compound, lVal, pVal, ctx.boostWad, ctx.totalShares);
        deepen(s);
        f.spotAfter = spot(s);
        return (s, f);
    }

    /// @notice Spot-preserving liquidity add. The depositor owns exactly the tokens they put in
    ///         (anchor-valued shares are minted by the hook). Virtuals move so the quote does not jump,
    ///         which is what stops "deposit USDG, steal discounted coin, redeem".
    /// @dev Below the anchor, real USDG may only replace virtual USDG (plus the virtual that backs any
    ///      coin deposited alongside it). A larger USDG deposit would mint virtual coin and pin the
    ///      discount, so the whole seed could be bought without the price climbing. That reverts.
    function addLiquidity(S memory s, uint256 dx, uint256 dy) internal pure {
        uint256 p = spot(s);
        uint256 yEff = s.y + s.vy;
        s.x += dx;
        s.y += dy;
        s.lpX += dx;
        s.lpY += dy;
        if (p != 0 && s.anchor != 0 && p < s.anchor) {
            uint256 yWant = yEff + Math.mulDiv(p, dx, C.WAD);
            if (s.y > yWant) revert DiscountDeposit();
        }
        if (p != 0) _retarget(s, p);
    }

    /// @notice Remove `dx` coin and `dy` USDG from the LP pot and retarget so spot is unchanged.
    function removeLiquidity(S memory s, uint256 dx, uint256 dy) internal pure {
        uint256 p = spot(s);
        if (dx > s.lpX || dy > s.lpY || dx > s.x || dy > s.y) revert Insufficient();
        s.lpX -= dx;
        s.lpY -= dy;
        s.x -= dx;
        s.y -= dy;
        if (p != 0 && s.x != 0) _retarget(s, p);
    }

    /// @notice Move `amount` of USDG that is already inside `y` from `lpY` into the fee split.
    ///         Used for the redeem fee so it compounds as a fee, not as principal.
    function relabelLpFee(S memory s, uint256 amount, uint256 boostWad, uint256 totalShares)
        internal
        pure
        returns (uint256 toLp)
    {
        if (amount == 0) return 0;
        if (amount > s.lpY) amount = s.lpY;
        uint256 lVal = lpValue(s);
        uint256 pVal = protoValue(s);
        s.lpY -= amount;
        // `_allocate` also increases `y`. This USDG is already in `y`, so undo that.
        toLp = _allocate(s, amount, lVal, pVal, boostWad, totalShares);
        s.y -= amount;
    }

    // ───────────────────────────── internals ─────────────────────────

    function _bps(S memory s, Ctx memory ctx, uint256 spotBefore, uint256 usdgGross, bool buying, uint256 dxCap)
        private
        pure
        returns (uint256 bps)
    {
        uint256 base = BridgeFee.baseFeeBps(tvl(s), ctx.gradTvl);
        // Provisional direction from a fee-less fill, then one refinement.
        uint256 net = usdgGross;
        uint256 dx = buying ? coinOut(s, net > 0 ? net : 0) : 0;
        if (dx > dxCap) dx = dxCap;
        uint256 spotAfter = spotBefore;
        if (dx > 0) {
            // Memory assignment is a reference. Clone before scratching, or the quote mutates the book.
            S memory t = _clone(s);
            t.x -= dx;
            uint256 spent = buyCost(s, dx);
            t.y += spent;
            spotAfter = spot(t);
        }
        bps = BridgeFee.applyStale(BridgeFee.directional(base, spotBefore, spotAfter, s.anchor), ctx.age);
    }

    function _grossFromNet(uint256 net, uint256 bps) private pure returns (uint256) {
        if (bps >= C.BPS) return net;
        return Math.mulDiv(net, C.BPS, C.BPS - bps, Math.Rounding.Ceil);
    }

    function _slices(Fill memory f, Ctx memory ctx) private pure {
        uint256 tip = Math.mulDiv(f.fee, C.TIP_SLICE_BPS, C.BPS);
        if (tip > ctx.tipRoom) tip = ctx.tipRoom;
        uint256 creator = ctx.graduated ? Math.mulDiv(f.fee, C.CREATOR_FEE_BPS, C.BPS) : 0;
        if (tip + creator > f.fee) creator = f.fee - tip;
        f.tip = tip;
        f.creator = creator;
        f.compound = f.fee - tip - creator;
    }

    /// @param dxCoin signed change in coin reserve (negative = coin leaves)
    /// @param dyPrincipal signed change in principal USDG, applied BEFORE the fee allocation
    function _absorb(S memory s, int256 dxCoin, int256 dyPrincipal, uint256 lVal, uint256 pVal) private pure {
        uint256 x2 = dxCoin >= 0 ? s.x + uint256(dxCoin) : s.x - uint256(-dxCoin);
        uint256 principal = principalY(s);
        if (dyPrincipal >= 0) principal += uint256(dyPrincipal);
        else principal -= uint256(-dyPrincipal);
        uint256 tot = lVal + pVal;
        if (tot == 0 || lVal == 0) {
            s.lpX = 0;
            s.lpY = 0;
            s.protoX = x2;
            s.protoY = principal;
        } else {
            s.lpX = Math.mulDiv(x2, lVal, tot);
            s.protoX = x2 - s.lpX;
            s.lpY = Math.mulDiv(principal, lVal, tot);
            s.protoY = principal - s.lpY;
        }
        s.x = x2;
        s.y = s.protoY + s.lpY + s.feePot;
    }

    /// @dev Adds `amount` of fresh USDG into `y` and splits it between protocol principal and the LP fee pot.
    ///      Boost multiplies LP *fee weight* only. Principal weights are the pre-trade anchor values.
    function _allocate(S memory s, uint256 amount, uint256 lVal, uint256 pVal, uint256 boostWad, uint256 totalShares)
        private
        pure
        returns (uint256 toLp)
    {
        if (amount == 0) return 0;
        uint256 lw = Math.mulDiv(lVal, boostWad, C.WAD);
        if (totalShares == 0 || lw == 0) toLp = 0;
        else toLp = Math.mulDiv(amount, lw, lw + pVal);
        s.protoY += amount - toLp;
        s.feePot += toLp;
        s.y += amount;
        return toLp;
    }

    function _clone(S memory s) private pure returns (S memory c) {
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

    function _spotAfterSell(S memory s, uint256 dx, uint256 gross) private pure returns (uint256) {
        S memory t = _clone(s);
        t.x += dx;
        if (gross > t.y) return spot(s);
        t.y -= gross;
        return spot(t);
    }

    function _dxToAnchor(S memory s) private pure returns (uint256) {
        uint256 xE = s.x + s.vx;
        uint256 yE = s.y + s.vy;
        if (xE <= 1 || yE == 0 || s.anchor == 0) return 0;
        // (xE − dx)^2 = yE · xE · WAD / anchor
        uint256 rad2 = Math.mulDiv(Math.mulDiv(yE, C.WAD, s.anchor), xE, 1);
        uint256 rad = Math.sqrt(rad2);
        if (rad >= xE) return 0;
        return xE - rad;
    }

    /// @dev G-7: proceeds cannot buy the same coin back (and one extra wei is kept in the pool).
    function _g7(S memory s, uint256 dx, uint256 gross) private pure returns (uint256) {
        if (gross == 0 || gross >= s.y) return gross >= s.y ? (s.y == 0 ? 0 : s.y - 1) : gross;
        S memory p = _clone(s);
        p.x = s.x + dx;
        p.y = s.y - gross;
        // Tail + ceil on the way back. If it still wouldn't cost more than `gross`, clamp.
        uint256 xE = p.x + p.vx;
        if (dx >= xE || dx >= p.x) return gross;
        uint256 yE = p.y + p.vy;
        uint256 back = Math.mulDiv(yE, dx, xE - dx, Math.Rounding.Ceil);
        back += _tail(back, dx, p.x);
        if (back <= gross) return back == 0 ? 0 : back - 1;
        return gross;
    }

    /// @dev Extra cost, rounded up. `f = amount / side`. Integral of f^30 is f^31/31, scaled by TAIL_K.
    function _tail(uint256 base, uint256 amount, uint256 side) private pure returns (uint256) {
        if (base == 0 || amount == 0 || side == 0) return 0;
        if (amount > side) amount = side;
        uint256 f = Math.mulDiv(amount, C.RAY, side, Math.Rounding.Ceil);
        if (f > C.RAY) f = C.RAY;
        uint256 p31 = _pow31(f);
        return Math.mulDiv(Math.mulDiv(base, C.TAIL_K, C.WAD, Math.Rounding.Ceil), p31, 31 * C.RAY, Math.Rounding.Ceil);
    }

    /// @notice Reset virtual reserves so `spot` equals `targetSpot` without moving real tokens.
    function retarget(S memory s, uint256 targetSpot) internal pure {
        _retarget(s, targetSpot);
    }

    function _retarget(S memory s, uint256 targetSpot) private pure {
        if (targetSpot == 0 || s.x + s.vx == 0) return;
        uint256 xE = s.x + s.vx;
        uint256 yWant = Math.mulDiv(targetSpot, xE, C.WAD);
        if (yWant > s.y) {
            s.vy = yWant - s.y;
            return;
        }
        s.vy = 0;
        if (s.y == 0) {
            s.vx = 0;
            return;
        }
        uint256 xWant = Math.mulDiv(s.y, C.WAD, targetSpot);
        s.vx = xWant > s.x ? xWant - s.x : 0;
    }

    function _pow31(uint256 g) private pure returns (uint256) {
        return g == 0 ? 0 : _m(_pow30(g), g);
    }

    function _pow30(uint256 g) private pure returns (uint256) {
        if (g == 0) return 0;
        uint256 g2 = _m(g, g);
        uint256 g4 = _m(g2, g2);
        uint256 g8 = _m(g4, g4);
        uint256 g16 = _m(g8, g8);
        return _m(_m(_m(g16, g8), g4), g2);
    }

    function _m(uint256 a, uint256 b) private pure returns (uint256) {
        return Math.mulDiv(a, b, C.RAY, Math.Rounding.Ceil);
    }

    function _i(uint256 v) private pure returns (int256) {
        return int256(v);
    }
}

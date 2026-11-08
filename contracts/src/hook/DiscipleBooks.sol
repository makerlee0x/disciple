// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiscipleLedger as LG} from "./libraries/DiscipleLedger.sol";
import {DiscipleDepth as DP} from "./libraries/DiscipleDepth.sol";
import {DiscipleSwapMath as SM} from "./libraries/DiscipleSwapMath.sol";

interface IV2R {
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IV3S {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function fee() external view returns (uint24);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}

interface IFactoryLike {
    function getPair(address, address) external view returns (address);
    function getPool(address, address, uint24) external view returns (address);
}

/// @title DiscipleBooks
/// @notice Linked (external) entry points for the LP ledger, so the hook stays under the 24 KB code limit. Each call
///         is a DELEGATECALL into this library operating on the hook's own storage; the logic is DiscipleLedger's,
///         unchanged. Only the O(1) swap record stays inlined in the hook.
library DiscipleBooks {
    using LG for LG.Book;

    function init(LG.Book storage bk, address creator, uint256 x, uint256 y, uint256 markX128) public {
        bk.init(creator, x, y, markX128);
    }

    /// @notice Advance the v4 source depth counter (DiscipleDepth) by up to `steps` reads.
    function walk(DP.Walk storage w, IPoolManager pm, PoolId id, uint256 steps) public {
        DP.step(w, pm, id, steps);
    }

    /// @dev The creator cut remembers the highest confirmed source TVL, fading linearly to nothing over this long.
    uint256 internal constant TVL_MEMORY = 1 days;

    /// @dev A pool's source TVL readings (quote raw). Slot layout matches the fields it replaced in the hook's Pool.
    struct Tvl {
        uint256 srcTvl; // latest reading; 0 = not known yet
        uint256 prevTvl; // the reading before it
        uint256 recTvl; // highest confirmed reading (the lower of two in a row), fading over TVL_MEMORY from recAt
        uint64 recAt;
        uint64 warmEnd; // until then the creator cut and graduation stay off
        uint8 seen; // readings since launch / first price, up to 2 (the launch reading never counts)
    }

    /// @notice Close the interval at `markX128`, judging the creator cut and graduation from `t`. `skimRoom` (quote
    ///         raw at the mark) is how much the pool's tip jar can still take; returns the coin/quote skimmed for it.
    function settle(LG.Book storage bk, Tvl storage t, uint256 markX128, bool dist, uint256 skimRoom)
        public
        returns (uint256 jx, uint256 jy)
    {
        (uint256 on, uint256 off, uint256 g) = _judge(t);
        (, jx, jy) = bk.settle(markX128, on, off, g, dist, skimRoom);
    }

    /// @dev Source TVL against manipulation (review D-02). Spot TVL can be pushed down or up for one transaction,
    ///      so no single reading decides anything:
    ///      - graduation is judged against the higher of the last two readings, so a dip must be seen twice in a
    ///        row and a spike delays it by at most two readings;
    ///      - the creator cut has hysteresis. It turns on only against the higher of the last two readings and a
    ///        memory (the highest reading confirmed by the next one, the lower of two in a row, fading linearly to 0
    ///        over TVL_MEMORY of real time). It turns off only against the lower of the last two readings. So one
    ///        spike or one dip does nothing to it; two spikes in a row turn it off for at most TVL_MEMORY; turning it
    ///        on by dips takes no honest pair of readings for TVL_MEMORY, then two dips in a row, and it stays on
    ///        until two honest readings in a row.
    ///      The launch reading never counts, and nothing is judged before two later readings and the end of the
    ///      warm-up. Same chain v4: one reading per finished counter pass (the cached total is not new evidence).
    function observe(Tvl storage p, uint256 cur, bool fresh) public {
        if (cur == 0 || !fresh) return;
        uint256 prev = p.srcTvl;
        p.prevTvl = prev;
        p.srcTvl = cur;
        uint8 n = p.seen;
        if (n < 2) p.seen = ++n;
        if (n < 2) return;
        uint256 m = cur < prev ? cur : prev;
        if (m >= _rec(p)) {
            p.recTvl = m;
            p.recAt = uint64(block.timestamp);
        }
    }

    function _rec(Tvl storage p) internal view returns (uint256) {
        uint256 age = block.timestamp - p.recAt;
        return age >= TVL_MEMORY ? 0 : Math.mulDiv(p.recTvl, TVL_MEMORY - age, TVL_MEMORY);
    }

    /// @dev TVLs for the ledger; all 0 = not judged yet (warm-up, too few readings). The creator cut turns on only
    ///      if both of the last two readings and the memory allow it, and off only if both readings say so.
    function _judge(Tvl storage p) internal view returns (uint256 on, uint256 off, uint256 g) {
        if (block.timestamp < p.warmEnd || p.seen < 2) return (0, 0, 0);
        (g, off) = p.srcTvl > p.prevTvl ? (p.srcTvl, p.prevTvl) : (p.prevTvl, p.srcTvl);
        on = _rec(p);
        if (g > on) on = g;
    }

    function deposit(LG.Book storage bk, address owner, uint256 dx, uint256 dy)
        public
        returns (uint256 id, uint256 shares, uint256 takeX, uint256 takeY)
    {
        return bk.deposit(owner, dx, dy);
    }

    function withdraw(LG.Book storage bk, uint256 id, address owner, uint256 s, uint256 bal)
        public
        returns (uint256 cx, uint256 cy)
    {
        return bk.withdraw(id, owner, s, bal);
    }

    function restake(LG.Book storage bk, uint256 id, address owner) public returns (uint256) {
        return bk.restake(id, owner);
    }

    function claim(LG.Book storage bk, uint256 id, address owner) public returns (uint256, uint256) {
        return bk.claim(id, owner);
    }

    /// @notice Hand the creator role on. A compounding creator's lot is made here, paid by the creator, not inside
    ///         a later price delivery (audit L-3).
    function setCreator(LG.Book storage bk, address creator, bool compounds) public {
        bk.creator = creator;
        bk.creatorCompounds = compounds;
        uint256 cl = bk.creatorLot;
        if (cl != 0) bk.lots[cl].owner = creator;
        else if (compounds) LG.makeCreatorLot(bk);
    }

    function claimCreator(LG.Book storage bk) public returns (uint256, uint256) {
        return bk.claimCreator();
    }

    function poke(LG.Book storage bk, uint256 id) public returns (uint256, uint256, uint256, uint256) {
        return bk.poke(id);
    }

    /// @notice Same-chain slopes and match bounds. No lag premium: both sides pay the pool fee, and the centre
    ///         itself only moves toward the leader by a bounded step per reading (see DiscipleSwapMath.stepToward).
    ///         The live leader price, read in the same call, bounds every fill.
    function sameQuote(uint256 anchorX128, uint256 tX128, uint24 fee, uint256 spot, uint24 srcFee)
        public
        pure
        returns (uint256 kb, uint256 ks, uint256 pb, uint256 ps)
    {
        uint256 g = SM.markup(1e18, fee);
        (kb, ks) = SM.slopes(anchorX128, tX128, g, g);
        uint256 srcAsk = Math.mulDiv(spot, 1e6, 1e6 - srcFee, Math.Rounding.Ceil);
        uint256 srcBid = Math.mulDiv(spot, 1e6 - srcFee, 1e6);
        (pb, ps) = SM.matchBounds(srcAsk, srcBid, 1);
    }

    /// @notice Split a tip worth `q` quote raw out of a jar of (`jx` coin, `jy` quote), valued at `aX128`: quote
    ///         first, then coin. Capped at 1/`div` of the jar's value, and at what it holds.
    function tip(uint256 jx, uint256 jy, uint256 aX128, uint256 q, uint256 div)
        public
        pure
        returns (uint256 cx, uint256 cy)
    {
        uint256 cap = (Math.mulDiv(jx, aX128, 1 << 128) + jy) / div;
        if (q > cap) q = cap;
        if (q <= jy) return (0, q);
        cy = jy;
        cx = Math.mulDiv(q - jy, 1 << 128, aX128);
        if (cx > jx) cx = jx;
    }

    // ---------------------------------------------------------------------------------------------
    // Source reads (moved out of the hook for size)
    // ---------------------------------------------------------------------------------------------

    /// @dev One pool's spot (X128 other raw per base raw) and fee in pips (v2: Uniswap's 0.3%).
    error BadParams();

    /// @notice A verified same-chain source pool's (base, other) tokens, native ETH mapped to `weth`. v2 / v3 are
    ///         checked through `factory` (a zero factory has no code, so the call reverts: that kind is off); v4
    ///         through its key, never one of the hook's own pools (this runs by DELEGATECALL, so `this` = the hook).
    function legTokens(
        uint8 kind,
        address target,
        bytes32 v4Id,
        PoolKey calldata k,
        bool baseIs0,
        address weth,
        address factory
    ) public view returns (address base, address other) {
        address t0;
        address t1;
        if (kind == 3) {
            if (keccak256(abi.encode(k)) != v4Id || address(k.hooks) == address(this)) revert BadParams();
            (t0, t1) = (Currency.unwrap(k.currency0), Currency.unwrap(k.currency1));
        } else {
            t0 = IV3S(target).token0();
            t1 = IV3S(target).token1();
            address real = kind == 1
                ? IFactoryLike(factory).getPair(t0, t1)
                : IFactoryLike(factory).getPool(t0, t1, IV3S(target).fee());
            if (real != target) revert BadParams();
        }
        if (t0 == address(0)) t0 = weth;
        (base, other) = baseIs0 ? (t0, t1) : (t1, t0);
    }

    /// @notice The reference leg's spot, or 0 if it cannot be read (no code, wrong interface, out-of-range data).
    function refSpot(IPoolManager pm, uint8 kind, address target, bytes32 v4Id, bool baseIs0)
        public
        view
        returns (uint256 spot)
    {
        if (kind == 3) {
            (spot,) = leg(pm, kind, target, v4Id, baseIs0);
            return spot;
        }
        bool v2 = kind == 1;
        (bool ok, bytes memory r) =
            target.staticcall(abi.encodeWithSelector(v2 ? IV2R.getReserves.selector : IV3S.slot0.selector));
        if (!ok || r.length < (v2 ? 96 : 224)) return 0;
        (uint256 a, uint256 b) = abi.decode(r, (uint256, uint256));
        if (v2) {
            if (a > type(uint112).max || b > type(uint112).max) return 0;
            (spot,) = _v2(a, b, baseIs0);
        } else {
            if (a > type(uint160).max) return 0;
            (spot,) = _concentrated(uint160(a), 0, baseIs0);
        }
    }

    function leg(IPoolManager pm, uint8 kind, address target, bytes32 v4Id, bool baseIs0)
        public
        view
        returns (uint256 spot, uint24 fee)
    {
        if (kind == 1) {
            (uint112 r0, uint112 r1,) = IV2R(target).getReserves();
            (spot,) = _v2(r0, r1, baseIs0);
            fee = 3000;
        } else if (kind == 2) {
            (uint160 sqrtP,,,,,,) = IV3S(target).slot0();
            (spot,) = _concentrated(sqrtP, 0, baseIs0);
            fee = IV3S(target).fee();
        } else {
            (uint160 sqrtP,,, uint24 lpFee) = StateLibrary.getSlot0(pm, PoolId.wrap(v4Id));
            (spot,) = _concentrated(sqrtP, 0, baseIs0);
            fee = lpFee;
        }
        if (fee >= 1e6) fee = 999_999;
    }

    /// @notice A pushed raw source state: v2 (reserve0, reserve1) or v3/v4 (sqrtPriceX96, liquidity).
    /// @notice Same-chain source TVL in quote raw: leg 1's real tokens valued at its spot `s1`, converted at the full
    ///         `spot` for two-hop. v2: reserves. v3: the pool's token balances. v4: the depth counter's last finished
    ///         pass (0 until the first pass finishes).
    function sourceTvl(
        uint8 kind,
        address target,
        bool coinIs0,
        bool twoHop,
        address coin,
        address x,
        DP.Walk storage w,
        uint256 s1,
        uint256 spot
    ) public view returns (uint256 tvl) {
        uint256 b;
        uint256 o;
        if (kind == 1) {
            (uint112 r0, uint112 r1,) = IV2R(target).getReserves();
            (b, o) = coinIs0 ? (r0, r1) : (r1, r0);
        } else if (kind == 2) {
            b = IERC20Like(coin).balanceOf(target);
            o = IERC20Like(x).balanceOf(target);
        } else {
            if (!w.done) return 0;
            (b, o) = coinIs0 ? (w.tot0, w.tot1) : (w.tot1, w.tot0);
        }
        tvl = Math.mulDiv(b, s1, 1 << 128) + o;
        if (twoHop) tvl = Math.mulDiv(tvl, spot, s1);
    }

    function pushed(bool isV2, uint256 a, uint256 b, bool coinIs0) public pure returns (uint256 price, uint256 tvl) {
        return isV2 ? _v2(a, b, coinIs0) : _concentrated(uint160(a), uint128(b), coinIs0);
    }

    function _v2(uint256 r0, uint256 r1, bool coinIs0) internal pure returns (uint256 spot, uint256 tvl) {
        (uint256 rc, uint256 rq) = coinIs0 ? (r0, r1) : (r1, r0);
        if (rc == 0 || rq == 0) return (0, 0);
        spot = Math.mulDiv(rq, (1 << 128), rc);
        tvl = 2 * rq;
    }

    /// @dev Spot from sqrtPriceX96 and a TVL proxy (virtual reserves at the current price, both sides in quote).
    function _concentrated(uint160 sqrtP, uint128 liq, bool coinIs0) internal pure returns (uint256 spot, uint256 tvl) {
        if (sqrtP == 0) return (0, 0);
        uint256 sp = uint256(sqrtP);
        uint256 q96 = 1 << 96;
        if (coinIs0) {
            spot = Math.mulDiv(sp, sp, 1 << 64); // sqrtP^2 / 2^192 * 2^128
            tvl = 2 * Math.mulDiv(uint256(liq), sp, q96);
        } else {
            spot = Math.mulDiv(Math.mulDiv((1 << 128), q96, sp), q96, sp); // 2^192 / sqrtP^2 * 2^128
            tvl = 2 * Math.mulDiv(uint256(liq), q96, sp);
        }
    }
}

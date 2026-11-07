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

    /// @notice Close the interval. `skimRoom` (quote wei at the mark) is how much the pool's tip jar can still take;
    ///         returns the coin/quote amounts skimmed out of the reserves for it.
    function settle(
        LG.Book storage bk,
        uint256 markX128,
        uint256 onTvl,
        uint256 offTvl,
        uint256 gradTvl,
        bool dist,
        uint256 skimRoom
    ) public returns (uint256 jx, uint256 jy) {
        (, jx, jy) = bk.settle(markX128, onTvl, offTvl, gradTvl, dist, skimRoom);
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

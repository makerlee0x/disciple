// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {BitMath} from "@uniswap/v4-core/src/libraries/BitMath.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title Disciple depth counter
/// @notice Counts the real tokens held by a Uniswap v4 pool's positions, the number Uniswap's own indexer shows as
///         TVL, a few storage reads at a time. v4 keeps no per-pool token totals (every pool's tokens sit in the
///         PoolManager together), so the counter walks the pool's initialised ticks from the bottom to the top,
///         adding each liquidity range's token0 / token1 at the price of the moment. When a pass reaches the top
///         its totals become the pool's TVL and the next pass starts. No keeper: the hook runs a few steps on the
///         first touch of each block (maker, 2026-11-04).
///
///         A pass spans several blocks, so a position added or removed mid-pass may be half counted until the next
///         pass. Running liquidity is clamped at zero for that reason. Uncollected fees are not counted.
library DiscipleDepth {
    struct Walk {
        int24 spacing; // source pool tick spacing; 0 = not counting
        int24 c; // next compressed tick (tick / spacing) to scan
        int24 lo; // tick where the current liquidity `liq` starts
        bool active; // a pass is in progress
        bool done; // at least one pass has finished
        uint128 liq; // running liquidity below tick c * spacing
        uint128 acc0; // this pass so far
        uint128 acc1;
        uint128 tot0; // last finished pass
        uint128 tot1;
    }

    /// @notice Run up to `steps` storage reads of the walk (one per bitmap word or initialised tick).
    function step(Walk storage w, IPoolManager pm, PoolId id, uint256 steps) internal {
        int24 sp = w.spacing;
        if (sp <= 0 || steps == 0) return;
        (uint160 sqrtP,,,) = StateLibrary.getSlot0(pm, id);
        if (sqrtP == 0) return;
        int24 maxC = TickMath.maxUsableTick(sp) / sp;
        int24 c;
        int24 lo;
        uint256 liq;
        uint256 a0;
        uint256 a1;
        if (w.active) {
            c = w.c;
            lo = w.lo;
            liq = w.liq;
            a0 = w.acc0;
            a1 = w.acc1;
        } else {
            c = TickMath.minUsableTick(sp) / sp;
            lo = c * sp;
        }
        while (steps != 0 && c <= maxC) {
            --steps;
            int16 word = int16(c >> 8);
            uint256 m = StateLibrary.getTickBitmap(pm, id, word) >> uint8(uint24(c & 0xff));
            if (m == 0) {
                // no initialised tick in the rest of this word: liquidity is unchanged across it
                c = (int24(word) + 1) * 256;
                continue;
            }
            int24 next = c + int24(uint24(BitMath.leastSignificantBit(m)));
            if (next > maxC) {
                c = maxC + 1;
                break;
            }
            // the range [lo, next) held `liq`; crossing `next` changes it
            (uint256 d0, uint256 d1) = _range(lo, next * sp, liq, sqrtP);
            a0 += d0;
            a1 += d1;
            (, int128 net) = StateLibrary.getTickLiquidity(pm, id, next * sp);
            if (steps != 0) --steps;
            int256 l = int256(liq) + net;
            liq = l <= 0 ? 0 : (l > int256(uint256(type(uint128).max)) ? type(uint128).max : uint256(l));
            lo = next * sp;
            c = next + 1;
        }
        if (c > maxC) {
            // the top: whatever liquidity is left (0 unless positions changed mid-pass) runs to the last tick
            (uint256 d0, uint256 d1) = _range(lo, maxC * sp, liq, sqrtP);
            a0 += d0;
            a1 += d1;
            w.tot0 = _cap(a0);
            w.tot1 = _cap(a1);
            w.done = true;
            w.active = false;
        } else {
            w.c = c;
            w.lo = lo;
            w.liq = uint128(liq);
            w.acc0 = _cap(a0);
            w.acc1 = _cap(a1);
            w.active = true;
        }
    }

    /// @dev Tokens held by `liq` over [lo, hi) at the current price, rounded up.
    function _range(int24 lo, int24 hi, uint256 liq, uint160 sqrtP) private pure returns (uint256 a0, uint256 a1) {
        if (liq == 0 || lo >= hi) return (0, 0);
        uint160 sa = TickMath.getSqrtPriceAtTick(lo);
        uint160 sb = TickMath.getSqrtPriceAtTick(hi);
        uint128 l = uint128(liq);
        if (sqrtP <= sa) {
            a0 = SqrtPriceMath.getAmount0Delta(sa, sb, l, true);
        } else if (sqrtP >= sb) {
            a1 = SqrtPriceMath.getAmount1Delta(sa, sb, l, true);
        } else {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtP, sb, l, true);
            a1 = SqrtPriceMath.getAmount1Delta(sa, sqrtP, l, true);
        }
    }

    function _cap(uint256 a) private pure returns (uint128) {
        return a > type(uint128).max ? type(uint128).max : uint128(a);
    }
}

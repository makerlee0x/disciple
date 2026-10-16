// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Truncated, time-weighted tick oracle (ring buffer of tick accumulators)
/// @notice Shared by DiscipleHook (post-grad pools), BondingCurve (curve phase) and QuotePricer (reference pool).
///         Ticks are always in "quote per token" orientation (callers convert pool ticks).
/// @dev Manipulation resistance, Uniswap-v3 style:
///      - at most one observation per block (the first write in a block wins);
///      - callers write the PRE-trade tick, so a price set inside the current block has zero time weight until
///        it survives into a later block (an add/pump/dump in one block cannot move the TWAP);
///      - every write is clamped to `lastTick ± maxTickDelta` ("truncated oracle"), so even a price held across
///        a block boundary can only move the recorded tick a bounded amount per block;
///      - `lagged` writes (QuotePricer, whose reference pool does not write on its own swaps) apply the PREVIOUS
///        recorded tick to the elapsed interval, so a permissionless poke after a flash move only affects the
///        future and still has to be sustained across blocks.
library TwapOracle {
    uint16 internal constant CARDINALITY = 1024;

    struct Observation {
        uint32 ts;
        int56 tickCumulative;
        int24 tick; // truncated tick recorded at ts (applies from ts onward)
        bool initialized;
    }

    struct State {
        uint16 index; // most recent observation
        uint16 count; // populated slots (≤ CARDINALITY)
        Observation[1024] obs;
    }

    error OracleUninitialized();

    function isInitialized(State storage s) internal view returns (bool) {
        return s.count != 0;
    }

    function initialize(State storage s, int24 tick) internal {
        s.index = 0;
        s.count = 1;
        s.obs[0] = Observation({ts: uint32(block.timestamp), tickCumulative: 0, tick: tick, initialized: true});
    }

    function clamp(int24 tick, int24 ref, int24 maxDelta) internal pure returns (int24) {
        if (maxDelta <= 0) return tick;
        int256 lo = int256(ref) - maxDelta;
        int256 hi = int256(ref) + maxDelta;
        int256 t = tick;
        if (t < lo) t = lo;
        if (t > hi) t = hi;
        if (t < TickMath.MIN_TICK) t = TickMath.MIN_TICK;
        if (t > TickMath.MAX_TICK) t = TickMath.MAX_TICK;
        return int24(t);
    }

    function last(State storage s) internal view returns (Observation memory) {
        return s.obs[s.index];
    }

    /// @notice Record `tick` (truncated). No-op if already written this block. Initializes on first call.
    /// @return wrote true if a new observation was stored
    function write(State storage s, int24 tick, int24 maxDelta, bool lagged) internal returns (bool wrote) {
        if (s.count == 0) {
            initialize(s, tick);
            return true;
        }
        Observation memory l = s.obs[s.index];
        uint32 nowTs = uint32(block.timestamp);
        if (l.ts == nowTs) return false;
        int24 t = clamp(tick, l.tick, maxDelta);
        int24 elapsedTick = lagged ? l.tick : t;
        int56 cum = l.tickCumulative + int56(elapsedTick) * int56(uint56(nowTs - l.ts));
        uint16 next = (s.index + 1) % CARDINALITY;
        s.obs[next] = Observation({ts: nowTs, tickCumulative: cum, tick: t, initialized: true});
        s.index = next;
        if (s.count < CARDINALITY) s.count++;
        return true;
    }

    /// @dev Tick cumulative at `target` (clamped to the oldest observation). `tailTick` applies after the last obs.
    function _cumAt(State storage s, uint32 target, int24 tailTick) private view returns (int56 cum, uint32 at) {
        Observation memory l = s.obs[s.index];
        if (target >= l.ts) return (l.tickCumulative + int56(tailTick) * int56(uint56(target - l.ts)), target);
        uint16 oldestIdx = s.count < CARDINALITY ? 0 : (s.index + 1) % CARDINALITY;
        Observation memory o = s.obs[oldestIdx];
        if (target <= o.ts) return (o.tickCumulative, o.ts);
        // binary search over [oldest, index] (logical positions 0..count-1)
        uint256 lo = 0;
        uint256 hi = s.count - 1;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            Observation memory m = s.obs[(oldestIdx + mid) % CARDINALITY];
            if (m.ts <= target) lo = mid;
            else hi = mid;
        }
        Observation memory a = s.obs[(oldestIdx + lo) % CARDINALITY];
        Observation memory b = s.obs[(oldestIdx + hi) % CARDINALITY];
        if (a.ts == target) return (a.tickCumulative, target);
        // each segment has a constant tick, so linear interpolation of the cumulative is exact
        int56 seg = b.tickCumulative - a.tickCumulative;
        return (a.tickCumulative + (seg * int56(uint56(target - a.ts))) / int56(uint56(b.ts - a.ts)), target);
    }

    /// @notice Time-weighted mean tick over `window` seconds ending now.
    /// @param tailTick tick that applies from the last observation to now (already truncated by the caller)
    /// @return meanTick arithmetic mean tick (rounded toward −∞)
    /// @return actualWindow seconds actually covered (shorter than `window` while history is young; 0 → tailTick)
    function consult(State storage s, uint32 window, int24 tailTick)
        internal
        view
        returns (int24 meanTick, uint32 actualWindow)
    {
        if (s.count == 0) revert OracleUninitialized();
        uint32 nowTs = uint32(block.timestamp);
        if (window == 0) return (tailTick, 0);
        uint32 startTarget = window > nowTs ? 0 : nowTs - window;
        (int56 cumNow,) = _cumAt(s, nowTs, tailTick);
        (int56 cumStart, uint32 startAt) = _cumAt(s, startTarget, tailTick);
        actualWindow = nowTs - startAt;
        if (actualWindow == 0) return (tailTick, 0);
        int56 d = cumNow - cumStart;
        int56 w = int56(uint56(actualWindow));
        int56 q = d / w;
        if (d < 0 && d % w != 0) q--;
        meanTick = int24(q);
    }

    /// @notice Truncated tail tick: current spot clamped against the last recorded tick.
    function tail(State storage s, int24 spotTick, int24 maxDelta) internal view returns (int24) {
        return clamp(spotTick, s.obs[s.index].tick, maxDelta);
    }

    // ── conversions (tick in quote-per-token orientation) ──

    /// @notice Tick of a quote-per-token price given as virtual reserves (full precision).
    function tickFromReserves(uint256 quoteReserve, uint256 tokenReserve) internal pure returns (int24) {
        uint256 ratioX192 = Math.mulDiv(quoteReserve, 1 << 192, tokenReserve);
        uint256 sq = Math.sqrt(ratioX192);
        if (sq < TickMath.MIN_SQRT_PRICE) sq = TickMath.MIN_SQRT_PRICE;
        if (sq >= TickMath.MAX_SQRT_PRICE) sq = TickMath.MAX_SQRT_PRICE - 1;
        return TickMath.getTickAtSqrtPrice(uint160(sq));
    }

    /// @notice quote raw * 1e18 / token raw at `tick`.
    function priceX18AtTick(int24 tick) internal pure returns (uint256) {
        uint160 sp = TickMath.getSqrtPriceAtTick(tick);
        return Math.mulDiv(Math.mulDiv(sp, sp, 1 << 64), 1e18, 1 << 128);
    }

    /// @notice USD WAD market cap at `tick` for `supply` token raw and `quoteUsd` (USD WAD per 1e18 quote raw).
    function mcapUsdAtTick(int24 tick, uint256 supply, uint256 quoteUsd) internal pure returns (uint256) {
        uint160 sp = TickMath.getSqrtPriceAtTick(tick);
        uint256 pX96 = Math.mulDiv(sp, sp, 1 << 96); // quote raw per token raw, X96
        return Math.mulDiv(Math.mulDiv(pX96, supply, 1 << 96), quoteUsd, 1e18);
    }
}

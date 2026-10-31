// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";

/// @title Disciple's v4 anchor: a hook oracle, or a 30-minute TWAP this hook samples itself
/// @notice Uniswap v4 has no `observe`. Two substitutes:
///         - `consult` on the reference pool's hook, which owns the units (an AI/NVDA pool can
///           return USDG per coin and USD TVL);
///         - this ring, which reads `slot0` through `StateLibrary` at most once per block.
///
///         The self-sampled pool must be the coin paired with this hook's quote token. A different
///         numeraire (AI/NVDA) cannot be converted here; use the oracle-hook path for that.
///
///         TVL for the self-sample is a zero-width liquidity proxy: `2 * in-range quote`. It is
///         manipulable by adding in-range liquidity. The stored TVL is then smoothed with a
///         30-minute half-life, capped per step, and graduated status then waits out the 77-minute
///         window. The price itself is a 30-minute TWAP with no spot fallback.
///
///         Sampling follows the v3 observation rule. The first sample is only a candidate: it is
///         not accrued, and a later block starts the ring at the tick it sees then, so a pushed
///         first tick never enters the mean. Once the ring is live, a new block accrues the tick
///         observed in the prior block for the elapsed time (no equality check — a trend still
///         moves), then stores the current tick as the next candidate. A second sample in the same
///         block only replaces that candidate, so a push, poke, and push-back in one transaction
///         does not weight the TWAP. The mean is not trusted until `MIN_SAMPLES` points exist and
///         the oldest is at least `TWAP_WINDOW` old. `peek` applies the same accrual in memory, so
///         a quote matches the sample a swap would write.
///
/// @dev Internal. `DiscipleAnchor` is the deployed library. This file is inlined there, not on its own.
library BridgeV4Anchor {
    uint16 internal constant CARD = 2048;
    /// @dev The confirming sample plus two later points. One observation is not a TWAP.
    uint16 internal constant MIN_SAMPLES = 3;

    struct Ring {
        uint16 next;
        uint16 count;
        uint32 lastTs;
        int24 lastTick;
        int56 cum;
        /// @dev Slot0 seen in `observedBlock`. It accrues on a later block. This block's tick does not.
        int24 observedTick;
        uint64 observedBlock;
        /// @dev False until a later block has confirmed that a sample exists. The first tick is dropped.
        bool started;
        /// @dev Distinguishes "never sampled" from a sample taken in block 0.
        bool seen;
    }

    struct Write {
        bool wrote;
        uint16 index;
        uint256 word;
    }

    /// @notice Record the pre-sample tick. At most one cumulative point per timestamp.
    function record(Ring storage ring, mapping(uint16 => uint256) storage obs, int24 tick) internal {
        Ring memory cur = ring;
        (Ring memory next, Write memory w) = _advance(cur, tick, uint32(block.timestamp), uint64(block.number));
        if (w.wrote) obs[w.index] = w.word;
        _store(ring, next);
    }

    /// @notice 30-minute mean tick, converted to quote-per-coin, plus the liquidity TVL proxy.
    ///         `ready` is false until `MIN_SAMPLES` points exist and the oldest is `TWAP_WINDOW` old.
    function read(
        Ring storage ring,
        mapping(uint16 => uint256) storage obs,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        bool coinIs0,
        uint8 coinDec,
        uint8 quoteDec
    ) internal view returns (bool ready, uint256 priceWad, uint256 tvlWad) {
        Write memory none;
        return _consult(ring, obs, none, sqrtPriceX96, liquidity, coinIs0, coinDec, quoteDec);
    }

    /// @notice Sample the reference pool's slot0, record it, and consult the ring.
    ///         An uninitialized pool (`sqrtPriceX96 == 0`) is ignored.
    function sample(
        IPoolManager manager,
        bytes32 refPoolId,
        Ring storage ring,
        mapping(uint16 => uint256) storage obs,
        bool coinIs0,
        uint8 coinDec,
        uint8 quoteDec
    ) internal returns (bool ready, uint256 priceWad, uint256 tvlWad) {
        (uint160 sqrtP, int24 tick, uint128 liq) = _slot(manager, refPoolId);
        if (sqrtP == 0) return (false, 0, 0);
        record(ring, obs, tick);
        return read(ring, obs, sqrtP, liq, coinIs0, coinDec, quoteDec);
    }

    /// @notice Consult the ring the way `sample` would, without writing. Quotes use this so they
    ///         match the accrual a swap in this block would commit.
    function peek(
        IPoolManager manager,
        bytes32 refPoolId,
        Ring storage ring,
        mapping(uint16 => uint256) storage obs,
        bool coinIs0,
        uint8 coinDec,
        uint8 quoteDec
    ) internal view returns (bool ready, uint256 priceWad, uint256 tvlWad) {
        (uint160 sqrtP, int24 tick, uint128 liq) = _slot(manager, refPoolId);
        if (sqrtP == 0) return (false, 0, 0);
        (Ring memory next, Write memory w) = _advance(ring, tick, uint32(block.timestamp), uint64(block.number));
        return _consult(next, obs, w, sqrtP, liq, coinIs0, coinDec, quoteDec);
    }

    /// @dev First sample is stored and not accrued. A later block starts the ring at the tick it
    ///      sees, discarding the unconfirmed candidate. After that, a new block accrues the prior
    ///      block's tick for the elapsed time and the current tick becomes the next candidate.
    ///      The same block only replaces the candidate.
    function advance(Ring memory ring, int24 tick, uint32 nowT, uint64 bn)
        internal
        pure
        returns (Ring memory, Write memory)
    {
        return _advance(ring, tick, nowT, bn);
    }

    function _advance(Ring memory ring, int24 tick, uint32 nowT, uint64 bn)
        private
        pure
        returns (Ring memory, Write memory w)
    {
        if (!ring.seen) {
            ring.seen = true;
            ring.observedTick = tick;
            ring.observedBlock = bn;
            return (ring, w);
        }
        if (bn == ring.observedBlock) {
            ring.observedTick = tick;
            return (ring, w);
        }
        if (!ring.started) {
            ring.started = true;
            ring.lastTs = nowT;
            ring.lastTick = tick;
            ring.cum = 0;
            ring.observedTick = tick;
            ring.observedBlock = bn;
            ring.next = 1;
            ring.count = 1;
            w.wrote = true;
            w.index = 0;
            w.word = _pack(nowT, 0);
            return (ring, w);
        }
        if (nowT != ring.lastTs) {
            ring.lastTick = ring.observedTick;
            int256 projected = int256(ring.cum) + int256(ring.lastTick) * int256(uint256(nowT - ring.lastTs));
            if (projected > type(int56).max || projected < type(int56).min) {
                ring.observedTick = tick;
                ring.observedBlock = bn;
                return (ring, w);
            }
            int56 cumNow = int56(projected);
            w.wrote = true;
            w.index = ring.next;
            w.word = _pack(nowT, cumNow);
            ring.next = uint16((uint256(ring.next) + 1) % CARD);
            if (ring.count < CARD) ring.count += 1;
            ring.cum = cumNow;
            ring.lastTs = nowT;
            ring.lastTick = tick;
        }
        ring.observedTick = tick;
        ring.observedBlock = bn;
        return (ring, w);
    }

    function _consult(
        Ring memory ring,
        mapping(uint16 => uint256) storage obs,
        Write memory w,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        bool coinIs0,
        uint8 coinDec,
        uint8 quoteDec
    ) internal view returns (bool ready, uint256 priceWad, uint256 tvlWad) {
        if (ring.count < MIN_SAMPLES) return (false, 0, 0);
        uint32 nowT = uint32(block.timestamp);
        if (nowT < uint32(C.TWAP_WINDOW)) return (false, 0, 0);
        uint32 target = nowT - uint32(C.TWAP_WINDOW);
        (uint32 oldestTs,) = _unpack(_at(ring, obs, 0, w));
        if (oldestTs > target) return (false, 0, 0);

        uint16 lo;
        uint16 hi = ring.count - 1;
        while (lo < hi) {
            uint16 mid = uint16((uint256(lo) + uint256(hi) + 1) / 2);
            (uint32 ts,) = _unpack(_at(ring, obs, mid, w));
            if (ts <= target) lo = mid;
            else hi = mid - 1;
        }
        (uint32 tsOld, int56 cumOld) = _unpack(_at(ring, obs, lo, w));
        uint32 dt = nowT - tsOld;
        if (dt == 0) return (false, 0, 0);
        int256 delta = _project(ring, nowT) - int256(cumOld);
        int256 mean = delta / int256(uint256(dt));
        if (delta < 0 && delta % int256(uint256(dt)) != 0) mean -= 1;
        if (mean < int256(TickMath.MIN_TICK) || mean > int256(TickMath.MAX_TICK)) return (false, 0, 0);
        uint160 sqrtTwap = TickMath.getSqrtPriceAtTick(int24(mean));
        priceWad = _priceWad(sqrtTwap, coinIs0, coinDec, quoteDec);
        if (priceWad == 0) return (false, 0, 0);
        tvlWad = _tvl(sqrtPriceX96, liquidity, coinIs0, quoteDec);
        ready = true;
    }

    function _store(Ring storage ring, Ring memory next) private {
        ring.next = next.next;
        ring.count = next.count;
        ring.lastTs = next.lastTs;
        ring.lastTick = next.lastTick;
        ring.cum = next.cum;
        ring.observedTick = next.observedTick;
        ring.observedBlock = next.observedBlock;
        ring.started = next.started;
        ring.seen = next.seen;
    }

    /// @dev Quote-token TVL of a zero-width in-range position: both sides valued in the quote.
    function _tvl(uint160 sqrtPriceX96, uint128 liquidity, bool coinIs0, uint8 quoteDec)
        private
        pure
        returns (uint256)
    {
        if (liquidity == 0 || sqrtPriceX96 == 0) return 0;
        uint256 q96 = uint256(1) << 96;
        uint256 amount0 = Math.mulDiv(uint256(liquidity), q96, uint256(sqrtPriceX96));
        uint256 amount1 = Math.mulDiv(uint256(liquidity), uint256(sqrtPriceX96), q96);
        uint256 quoteRaw = (coinIs0 ? amount1 : amount0) * 2;
        if (quoteDec >= 18) return quoteRaw / 10 ** (quoteDec - 18);
        return quoteRaw * 10 ** (18 - quoteDec);
    }

    function slot(IPoolManager manager, bytes32 refPoolId)
        internal
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity)
    {
        return _slot(manager, refPoolId);
    }

    function _slot(IPoolManager manager, bytes32 refPoolId)
        private
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity)
    {
        PoolId pid = PoolId.wrap(refPoolId);
        (sqrtPriceX96, tick,,) = StateLibrary.getSlot0(manager, pid);
        liquidity = StateLibrary.getLiquidity(manager, pid);
    }

    function _project(Ring memory ring, uint32 nowT) private pure returns (int256) {
        int256 dt = int256(uint256(nowT - ring.lastTs));
        return int256(ring.cum) + int256(ring.lastTick) * dt;
    }

    function _index(Ring memory ring, uint16 logical) private pure returns (uint16) {
        if (ring.count < CARD) return logical;
        return uint16((uint256(ring.next) + uint256(logical)) % CARD);
    }

    function _at(Ring memory ring, mapping(uint16 => uint256) storage obs, uint16 logical, Write memory w)
        private
        view
        returns (uint256)
    {
        uint16 idx = _index(ring, logical);
        if (w.wrote && idx == w.index) return w.word;
        return obs[idx];
    }

    function _pack(uint32 ts, int56 cum) private pure returns (uint256) {
        return (uint256(ts) << 56) | uint256(uint56(cum));
    }

    function _unpack(uint256 word) private pure returns (uint32 ts, int56 cum) {
        ts = uint32(word >> 56);
        cum = int56(uint56(word));
    }

    /// @dev quote-per-coin in WAD. Same Q64.96 fraction as `BridgeV3Anchor`. `coinIs0` means the
    ///      coin is token0, so the quote is token1.
    function _priceWad(uint160 sqrtPriceX96, bool coinIs0, uint8 coinDec, uint8 quoteDec)
        private
        pure
        returns (uint256)
    {
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 q96 = uint256(1) << 96;
        if (coinIs0) {
            uint256 scale = 10 ** (uint256(coinDec) + 18 - quoteDec);
            return Math.mulDiv(Math.mulDiv(sqrtP, sqrtP, q96), scale, q96);
        }
        uint256 num = 10 ** (uint256(coinDec) + 18);
        uint256 den = 10 ** uint256(quoteDec);
        uint256 inv = Math.mulDiv(Math.mulDiv(num, q96, sqrtP), q96, sqrtP);
        return inv / den;
    }
}

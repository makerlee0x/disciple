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
///         30-minute half-life, and graduated status then waits out the 77-minute window. The price
///         itself is a 30-minute TWAP with no spot fallback. A sample writes the tick carried from
///         a prior block, not this transaction's `slot0`, so a push, poke, and push-back in one
///         transaction cannot weight the TWAP.
///
/// @dev Public functions are linked with DELEGATECALL so this code is not copied into every facet.
library BridgeV4Anchor {
    uint16 internal constant CARD = 2048;

    struct Ring {
        uint16 next;
        uint16 count;
        uint32 lastTs;
        int24 lastTick;
        int56 cum;
        /// @dev Slot0 seen in `observedBlock`. It becomes `lastTick` only on a later block, and
        ///      only if the pool is still at that price. This transaction's tick does not accrue.
        int24 observedTick;
        uint64 observedBlock;
    }

    /// @notice Record the price as of the end of a previous block. At most one cumulative point
    ///         per timestamp. The tick argument is this transaction's `slot0` and is stored only
    ///         as a candidate. The cumulative advances by `lastTick`, which is a price that was
    ///         already observed in an earlier block and is still the pool's price. A push, sample,
    ///         and push-back in one transaction therefore cannot weight the TWAP.
    function record(Ring storage ring, mapping(uint16 => uint256) storage obs, int24 tick) public {
        uint32 nowT = uint32(block.timestamp);
        uint64 bn = uint64(block.number);
        if (ring.count == 0) {
            ring.lastTs = nowT;
            ring.lastTick = tick;
            ring.observedTick = tick;
            ring.observedBlock = bn;
            ring.cum = 0;
            obs[0] = _pack(nowT, 0);
            ring.next = 1;
            ring.count = 1;
            return;
        }
        // Promote a prior block's tick only when this block still shows it. A one-transaction
        // spike fails the equality on the next block, after the price has been put back.
        if (ring.observedBlock != 0 && ring.observedBlock < bn && tick == ring.observedTick) {
            ring.lastTick = tick;
        }
        if (nowT == ring.lastTs) return;
        int256 projected = _project(ring, nowT);
        if (projected > type(int56).max || projected < type(int56).min) return;
        int56 cumNow = int56(projected);
        obs[ring.next] = _pack(nowT, cumNow);
        ring.next = uint16((uint256(ring.next) + 1) % CARD);
        if (ring.count < CARD) ring.count += 1;
        ring.cum = cumNow;
        ring.lastTs = nowT;
        ring.observedTick = tick;
        ring.observedBlock = bn;
    }

    /// @notice 30-minute mean tick, converted to quote-per-coin, plus the liquidity TVL proxy.
    ///         `ready` is false until the oldest sample is at least `TWAP_WINDOW` old.
    function read(
        Ring storage ring,
        mapping(uint16 => uint256) storage obs,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        bool coinIs0,
        uint8 coinDec,
        uint8 quoteDec
    ) public view returns (bool ready, uint256 priceWad, uint256 tvlWad) {
        if (ring.count == 0) return (false, 0, 0);
        uint32 nowT = uint32(block.timestamp);
        if (nowT < uint32(C.TWAP_WINDOW)) return (false, 0, 0);
        uint32 target = nowT - uint32(C.TWAP_WINDOW);
        (uint32 oldestTs,) = _unpack(obs[_index(ring, 0)]);
        if (oldestTs > target) return (false, 0, 0);

        uint16 lo;
        uint16 hi = ring.count - 1;
        while (lo < hi) {
            uint16 mid = uint16((uint256(lo) + uint256(hi) + 1) / 2);
            (uint32 ts,) = _unpack(obs[_index(ring, mid)]);
            if (ts <= target) lo = mid;
            else hi = mid - 1;
        }
        (uint32 tsOld, int56 cumOld) = _unpack(obs[_index(ring, lo)]);
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
    ) public returns (bool ready, uint256 priceWad, uint256 tvlWad) {
        (uint160 sqrtP, int24 tick, uint128 liq) = _slot(manager, refPoolId);
        if (sqrtP == 0) return (false, 0, 0);
        record(ring, obs, tick);
        return read(ring, obs, sqrtP, liq, coinIs0, coinDec, quoteDec);
    }

    /// @notice Consult the ring against the current slot0 without writing a sample.
    function peek(
        IPoolManager manager,
        bytes32 refPoolId,
        Ring storage ring,
        mapping(uint16 => uint256) storage obs,
        bool coinIs0,
        uint8 coinDec,
        uint8 quoteDec
    ) public view returns (bool ready, uint256 priceWad, uint256 tvlWad) {
        (uint160 sqrtP,, uint128 liq) = _slot(manager, refPoolId);
        if (sqrtP == 0) return (false, 0, 0);
        return read(ring, obs, sqrtP, liq, coinIs0, coinDec, quoteDec);
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

    function _slot(IPoolManager manager, bytes32 refPoolId)
        private
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity)
    {
        PoolId pid = PoolId.wrap(refPoolId);
        (sqrtPriceX96, tick,,) = StateLibrary.getSlot0(manager, pid);
        liquidity = StateLibrary.getLiquidity(manager, pid);
    }

    function _project(Ring storage ring, uint32 nowT) private view returns (int256) {
        int256 dt = int256(uint256(nowT - ring.lastTs));
        return int256(ring.cum) + int256(ring.lastTick) * dt;
    }

    function _index(Ring storage ring, uint16 logical) private view returns (uint16) {
        if (ring.count < CARD) return logical;
        return uint16((uint256(ring.next) + uint256(logical)) % CARD);
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeV2Anchor} from "./libraries/BridgeV2Anchor.sol";
import {
    BridgeV3Anchor,
    IUniswapV3FactoryView,
    IUniswapV3Liquidity,
    IUniswapV3PoolLike
} from "./libraries/BridgeV3Anchor.sol";
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";

/// @title Fixed price-source library
/// @notice v2, v3, and v4 reads. No token custody. Linked into the hook. The address is baked into
///         the hook bytecode and cannot be replaced. `prepareV3` is the one call that is not a view:
///         it asks the source pool to grow its oracle cardinality. The hook writes the sample ring.
library DiscipleAnchor {
    function v2Matches(address factory, address pair, address coin, address quote) public view returns (bool) {
        return BridgeV2Anchor.matches(factory, pair, coin, quote);
    }

    function v2Tick(address factory, address pair, address coin, address quote)
        public
        view
        returns (bool ok, int24 tick)
    {
        return BridgeV2Anchor.reserveTick(factory, pair, coin, quote);
    }

    function v2Tvl(address pair, address coin, address quote, uint8 coinDec, uint8 quoteDec, uint256 priceWad)
        public
        view
        returns (uint256)
    {
        return BridgeV2Anchor.tvl(pair, coin, quote, coinDec, quoteDec, priceWad);
    }

    /// @dev Factory identity only. `fee == 0` cannot be looked up: `getPool` takes a fee tier.
    ///      That is not a fee cap. v4 fees, including zero, are not checked here.
    function v3FactoryMatch(address factory, address pool, address coin, address quote, uint24 fee)
        public
        view
        returns (bool coin0)
    {
        if (factory == address(0) || pool == address(0) || fee == 0) return false;
        if (IUniswapV3FactoryView(factory).getPool(coin, quote, fee) != pool) return false;
        address t0 = IUniswapV3PoolLike(pool).token0();
        address t1 = IUniswapV3PoolLike(pool).token1();
        bool zero = t0 == coin && t1 == quote;
        if (!zero && !(t0 == quote && t1 == coin)) return false;
        return true;
    }

    /// @dev Grow the oracle, then require a 7-day observation and a 30-minute observation.
    ///      Cardinality of 2 is not enough: the 30-minute read has to succeed.
    function prepareV3(address pool) public returns (bool) {
        try IUniswapV3Liquidity(pool).increaseObservationCardinalityNext(C.V3_CARDINALITY_NEXT) {}
        catch {
            return false;
        }
        if (!_observeOne(pool, uint32(C.MIN_REF_AGE))) return false;
        return _observeOne(pool, uint32(C.TWAP_WINDOW));
    }

    /// @dev True when the hook does not return a beforeSwap delta. Address zero passes.
    ///      An afterSwap fee hook passes. This hook itself does not.
    function hookAllowed(address hooks) public pure returns (bool) {
        return (uint160(hooks) & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) == 0;
    }

    function v2Coin0(address pair, address coin) public view returns (bool) {
        return BridgeV2Anchor.coinIsToken0(pair, coin);
    }

    function v2Accrued(address pair) public view returns (bool ok, uint256 price0Cum, uint256 price1Cum) {
        (ok, price0Cum, price1Cum,,) = BridgeV2Anchor.accrued(pair);
    }

    /// @dev Reserve spot, for the create-time size gate only. Swaps do not read this.
    function v2SpotPrice(address factory, address pair, address coin, address quote, uint8 coinDec, uint8 quoteDec)
        public
        view
        returns (bool ok, uint256 priceWad)
    {
        int24 tick;
        (ok, tick) = BridgeV2Anchor.reserveTick(factory, pair, coin, quote);
        if (!ok) return (false, 0);
        bool coin0 = BridgeV2Anchor.coinIsToken0(pair, coin);
        priceWad = BridgeV3Anchor.priceFromSqrt(TickMath.getSqrtPriceAtTick(tick), coin0, coinDec, quoteDec);
        ok = priceWad != 0;
    }

    function v2IntervalTick(uint256 newer, uint256 older, uint32 dt, bool inverted)
        public
        pure
        returns (bool ok, int24 tick)
    {
        return BridgeV2Anchor.tickFromCum(newer, older, dt, inverted);
    }

    /// @dev Canonical pool, then `observe([30 minutes, 1])`. The divisor is 1799 seconds.
    ///      TVL is in-range liquidity at the TWAP sqrt, not token balances and not slot0.
    function readV3(
        address factory,
        address pool,
        address coin,
        address quote,
        uint24 fee,
        uint8 coinDec,
        uint8 quoteDec
    ) public view returns (bool ok, uint256 priceWad, uint256 tvlWad) {
        if (!v3FactoryMatch(factory, pool, coin, quote, fee)) return (false, 0, 0);
        bool coin0 = IUniswapV3PoolLike(pool).token0() == coin;
        uint32[] memory ago = new uint32[](2);
        ago[0] = uint32(C.TWAP_WINDOW);
        ago[1] = 1;
        try IUniswapV3PoolLike(pool).observe(ago) returns (int56[] memory cumulatives, uint160[] memory) {
            uint256 window = C.TWAP_WINDOW - 1;
            priceWad = BridgeV3Anchor.priceFromDelta(cumulatives[1], cumulatives[0], window, coin0, coinDec, quoteDec);
            if (priceWad == 0) return (false, 0, 0);
            int256 delta = int256(cumulatives[1]) - int256(cumulatives[0]);
            int256 mean = delta / int256(window);
            if (delta < 0 && delta % int256(window) != 0) mean -= 1;
            if (mean < int256(TickMath.MIN_TICK) || mean > int256(TickMath.MAX_TICK)) return (false, 0, 0);
            uint128 liq = IUniswapV3Liquidity(pool).liquidity();
            tvlWad = BridgeV4Anchor.inRangeQuote(TickMath.getSqrtPriceAtTick(int24(mean)), liq, coin0, quoteDec);
            ok = true;
        } catch {
            return (false, 0, 0);
        }
    }

    function inRangeQuote(uint160 sqrtPriceX96, uint128 liquidity, bool coinIs0, uint8 quoteDec)
        public
        pure
        returns (uint256)
    {
        return BridgeV4Anchor.inRangeQuote(sqrtPriceX96, liquidity, coinIs0, quoteDec);
    }

    function advance(BridgeV4Anchor.Ring memory ring, int24 tick, uint32 nowT, uint64 blockNumber)
        public
        pure
        returns (BridgeV4Anchor.Ring memory, BridgeV4Anchor.Write memory)
    {
        return BridgeV4Anchor.advance(ring, tick, nowT, blockNumber);
    }

    function consult(
        BridgeV4Anchor.Ring memory ring,
        mapping(uint16 => uint256) storage obs,
        BridgeV4Anchor.Write memory w,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        bool coinIs0,
        uint8 coinDec,
        uint8 quoteDec
    ) public view returns (bool ready, uint256 priceWad, uint256 tvlWad) {
        return BridgeV4Anchor._consult(ring, obs, w, sqrtPriceX96, liquidity, coinIs0, coinDec, quoteDec);
    }

    function v4Slot(IPoolManager manager, bytes32 refPoolId)
        public
        view
        returns (bool ok, int24 tick, uint160 sqrtPriceX96, uint128 liquidity)
    {
        (sqrtPriceX96, tick, liquidity) = BridgeV4Anchor.slot(manager, refPoolId);
        ok = sqrtPriceX96 != 0;
    }

    /// @dev Accrue `tick` in memory and consult. Does not write the ring.
    function peekTick(
        BridgeV4Anchor.Ring memory ring,
        mapping(uint16 => uint256) storage obs,
        int24 tick,
        bool coinIs0,
        uint8 coinDec,
        uint8 quoteDec
    ) public view returns (bool ready, uint256 priceWad) {
        (BridgeV4Anchor.Ring memory next, BridgeV4Anchor.Write memory w) =
            BridgeV4Anchor.advance(ring, tick, uint32(block.timestamp), uint64(block.number));
        (ready, priceWad,) = BridgeV4Anchor._consult(next, obs, w, 0, 0, coinIs0, coinDec, quoteDec);
    }

    function _observeOne(address pool, uint32 ago) private view returns (bool) {
        uint32[] memory secs = new uint32[](1);
        secs[0] = ago;
        try IUniswapV3PoolLike(pool).observe(secs) returns (int56[] memory, uint160[] memory) {
            return true;
        } catch {
            return false;
        }
    }
}

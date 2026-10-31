// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeV2Anchor} from "./libraries/BridgeV2Anchor.sol";
import {
    BridgeV3Anchor,
    IUniswapV3FactoryView,
    IUniswapV3PoolLike,
    IUniswapV3Slot0
} from "./libraries/BridgeV3Anchor.sol";
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";

/// @title Fixed price-source library
/// @notice v2, v3, and v4 reads. No state and no token custody. Linked into the hook. The address is
///         baked into the hook bytecode and cannot be replaced. Every function is `view` or `pure`.
///         The hook writes the sample ring itself.
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

    /// @dev Factory pool and a long enough `slot0` cardinality. Does not call `observe`.
    function v3Ready(address factory, address pool, address coin, address quote, uint24 fee)
        public
        view
        returns (bool)
    {
        if (factory == address(0) || pool == address(0) || fee == 0) return false;
        if (IUniswapV3FactoryView(factory).getPool(coin, quote, fee) != pool) return false;
        address t0;
        address t1;
        try IUniswapV3PoolLike(pool).token0() returns (address a) {
            t0 = a;
        } catch {
            return false;
        }
        try IUniswapV3PoolLike(pool).token1() returns (address b) {
            t1 = b;
        } catch {
            return false;
        }
        bool coin0 = t0 == coin && t1 == quote;
        if (!coin0 && !(t0 == quote && t1 == coin)) return false;
        try IUniswapV3Slot0(pool).slot0() returns (
            uint160, int24, uint16, uint16 observationCardinality, uint16, uint8, bool
        ) {
            return observationCardinality >= C.MIN_V3_CARDINALITY;
        } catch {
            return false;
        }
    }

    /// @dev Canonical pool, cardinality, then `observe`. `ok` is false when any check fails.
    function readV3(
        address factory,
        address pool,
        address coin,
        address quote,
        uint24 fee,
        uint8 coinDec,
        uint8 quoteDec
    ) public view returns (bool ok, uint256 priceWad, uint256 tvlWad) {
        if (factory == address(0) || pool == address(0) || fee == 0) return (false, 0, 0);
        if (IUniswapV3FactoryView(factory).getPool(coin, quote, fee) != pool) return (false, 0, 0);
        (,,, uint16 card,,,) = IUniswapV3Slot0(pool).slot0();
        if (card < C.MIN_V3_CARDINALITY) return (false, 0, 0);
        address t0;
        address t1;
        try IUniswapV3PoolLike(pool).token0() returns (address a) {
            t0 = a;
            t1 = IUniswapV3PoolLike(pool).token1();
        } catch {
            return (false, 0, 0);
        }
        bool coin0 = t0 == coin && t1 == quote;
        if (!coin0 && !(t0 == quote && t1 == coin)) return (false, 0, 0);
        uint32[] memory ago = new uint32[](2);
        ago[0] = uint32(C.TWAP_WINDOW);
        ago[1] = 0;
        try IUniswapV3PoolLike(pool).observe(ago) returns (int56[] memory cumulatives, uint160[] memory) {
            priceWad = BridgeV3Anchor.priceFromDelta(cumulatives[1], cumulatives[0], coin0, coinDec, quoteDec);
            if (priceWad == 0) return (false, 0, 0);
            uint256 coinBal = _norm(IERC20(coin).balanceOf(pool), coinDec);
            uint256 quoteBal = _norm(IERC20(quote).balanceOf(pool), quoteDec);
            tvlWad = Math.mulDiv(coinBal, priceWad, C.WAD) + quoteBal;
            ok = true;
        } catch {
            return (false, 0, 0);
        }
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

    function _norm(uint256 raw, uint8 dec) private pure returns (uint256) {
        if (dec >= 18) return raw / 10 ** (dec - 18);
        return raw * 10 ** (18 - dec);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

/// @title Uniswap v2 pair check and prior-block cumulative
/// @notice The pair must be `factory.getPair(coin, quote)`. The trading price is a TWAP of cumulative
///         prices from completed intervals. A same-block reserve change is not accrued: v2 writes the
///         pre-swap price into the cumulative before it stores the new reserves. There is no move cap.
///         `spotTick` exists only as a create-time size gate, not as the anchor.
library BridgeV2Anchor {
    function coinIsToken0(address pair, address coin) internal view returns (bool) {
        return IUniswapV2Pair(pair).token0() == coin;
    }

    /// @dev True when `pair` is the factory pair for this coin and quote.
    function matches(address factory, address pair, address coin, address quote) internal view returns (bool) {
        if (factory == address(0) || pair == address(0) || coin == address(0) || quote == address(0)) return false;
        if (IUniswapV2Factory(factory).getPair(coin, quote) != pair) return false;
        address t0 = IUniswapV2Pair(pair).token0();
        address t1 = IUniswapV2Pair(pair).token1();
        return (t0 == coin && t1 == quote) || (t0 == quote && t1 == coin);
    }

    /// @dev Cumulative price brought forward with the reserves from the last completed update.
    ///      When `blockTimestampLast == now`, the pair already accrued the pre-swap reserves and the
    ///      current reserves must not be added. Otherwise the stored reserves are still the previous
    ///      block's and accruing them is a past price.
    function accrued(address pair)
        internal
        view
        returns (bool ok, uint256 price0Cum, uint256 price1Cum, uint112 reserve0, uint112 reserve1)
    {
        uint32 stamp;
        (reserve0, reserve1, stamp) = IUniswapV2Pair(pair).getReserves();
        price0Cum = IUniswapV2Pair(pair).price0CumulativeLast();
        price1Cum = IUniswapV2Pair(pair).price1CumulativeLast();
        uint32 nowT = uint32(block.timestamp);
        if (stamp != nowT && reserve0 != 0 && reserve1 != 0) {
            uint32 elapsed;
            unchecked {
                elapsed = nowT - stamp;
            }
            price0Cum += _uq(reserve1, reserve0) * uint256(elapsed);
            price1Cum += _uq(reserve0, reserve1) * uint256(elapsed);
        }
        ok = reserve0 != 0 && reserve1 != 0;
    }

    /// @dev Tick of token1 per token0 from a completed cumulative interval. `dt == 0` is not a sample.
    function tickFromCum(uint256 newer, uint256 older, uint32 dt, bool inverted)
        internal
        pure
        returns (bool ok, int24 tick)
    {
        if (dt == 0 || newer < older) return (false, 0);
        uint256 uq = (newer - older) / uint256(dt);
        if (uq == 0) return (false, 0);
        uint160 sqrtP = inverted ? _invSqrt(uq) : _sqrtFromUq(uq);
        if (sqrtP == 0) return (false, 0);
        return (true, TickMath.getTickAtSqrtPrice(sqrtP));
    }

    /// @dev Tick of token1 per token0 from reserves. Size gate only. Not the trading anchor.
    function reserveTick(address factory, address pair, address coin, address quote)
        internal
        view
        returns (bool ok, int24 tick)
    {
        if (!matches(factory, pair, coin, quote)) return (false, 0);
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        uint160 sqrtP = _sqrtPriceX96(r0, r1);
        if (sqrtP == 0) return (false, 0);
        return (true, TickMath.getTickAtSqrtPrice(sqrtP));
    }

    /// @dev Both balances valued at `priceWad` (quote per 1e18 coin). A donation moves this, not the ring.
    function tvl(address pair, address coin, address quote, uint8 coinDec, uint8 quoteDec, uint256 priceWad)
        internal
        view
        returns (uint256)
    {
        if (priceWad == 0) return 0;
        uint256 coinBal = _norm(IERC20(coin).balanceOf(pair), coinDec);
        uint256 quoteBal = _norm(IERC20(quote).balanceOf(pair), quoteDec);
        return Math.mulDiv(coinBal, priceWad, C.WAD) + quoteBal;
    }

    /// @dev `sqrt(reserve1 / reserve0) * 2^96`, clamped to a tick the ring can store.
    function _sqrtPriceX96(uint112 r0, uint112 r1) private pure returns (uint160) {
        if (r0 == 0 || r1 == 0) return 0;
        uint256 s0 = Math.sqrt(uint256(r0));
        uint256 s1 = Math.sqrt(uint256(r1));
        if (s0 == 0) return 0;
        uint256 px = Math.mulDiv(s1, uint256(1) << 96, s0);
        if (px < TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE;
        if (px > TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE;
        return uint160(px);
    }

    function _norm(uint256 raw, uint8 dec) private pure returns (uint256) {
        if (dec >= 18) return raw / 10 ** (dec - 18);
        return raw * 10 ** (18 - dec);
    }

    /// @dev reserveNum/reserveDen as UQ112.112, matching UniswapV2's price cumulative.
    function _uq(uint112 num, uint112 den) private pure returns (uint256) {
        return (uint256(num) << 112) / uint256(den);
    }

    /// @dev sqrt(uq112) * 2^40 = sqrt(price) * 2^96.
    function _sqrtFromUq(uint256 uq) private pure returns (uint160) {
        uint256 root = Math.sqrt(uq);
        if (root == 0) return 0;
        uint256 px = root << 40;
        if (px < TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE;
        if (px > TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE;
        return uint160(px);
    }

    /// @dev Price is the reciprocal of `uq` (token0 per token1). sqrtPriceX96 = 2^152 / sqrt(uq).
    function _invSqrt(uint256 uq) private pure returns (uint160) {
        uint256 root = Math.sqrt(uq);
        if (root == 0) return 0;
        uint256 px = (uint256(1) << 152) / root;
        if (px < TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE;
        if (px > TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE;
        return uint160(px);
    }
}

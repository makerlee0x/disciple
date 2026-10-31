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
}

/// @title Uniswap v2 pair check and reserve tick
/// @notice The pair must be `factory.getPair(coin, quote)`. The reserve ratio becomes a v3-style tick
///         so the hook's ring can average it. There is no v2 `observe`.
library BridgeV2Anchor {
    /// @dev True when `pair` is the factory pair for this coin and quote.
    function matches(address factory, address pair, address coin, address quote) internal view returns (bool) {
        if (factory == address(0) || pair == address(0) || coin == address(0) || quote == address(0)) return false;
        if (IUniswapV2Factory(factory).getPair(coin, quote) != pair) return false;
        address t0 = IUniswapV2Pair(pair).token0();
        address t1 = IUniswapV2Pair(pair).token1();
        return (t0 == coin && t1 == quote) || (t0 == quote && t1 == coin);
    }

    /// @dev Tick of token1 per token0, from reserves. `ok` is false when the pair is empty or not canonical.
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
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BridgeConstants as C} from "./BridgeConstants.sol";

/// @notice The slice of a Uniswap v3 pool this hook reads. `observe` is the 30-minute TWAP.
///         `slot0` is intentionally not part of the interface: a one-block spot is not an anchor.
interface IUniswapV3PoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface IUniswapV3FactoryView {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Slot0 {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @title Disciple's same-chain anchor: 30-minute v3 TWAP and balance TVL
/// @notice The reference pool must be `coin` paired with Disciple's quote token (USDG on Robinhood
///         Chain, or whatever quote the hook was deployed with). A WETH pair is not treated as dollars.
///         TVL is the pool's token balances valued at the TWAP, so a spot donation moves TVL and not the
///         price. `observe` reverts when the pool has less than 30 minutes of oracle history; this
///         library does not fall back to spot.
library BridgeV3Anchor {
    error BadPair();
    error BadTwap();

    /// @return priceWad Normalized quote token per 1e18 coin units (18-dec).
    /// @return tvlWad Both pool balances valued at that TWAP, in 18-dec quote tokens.
    function read(address pool, address coin, address quote, uint8 coinDec, uint8 quoteDec)
        internal
        view
        returns (uint256 priceWad, uint256 tvlWad)
    {
        address t0 = IUniswapV3PoolLike(pool).token0();
        address t1 = IUniswapV3PoolLike(pool).token1();
        bool coin0 = t0 == coin && t1 == quote;
        if (!coin0 && !(t0 == quote && t1 == coin)) revert BadPair();

        uint32[] memory ago = new uint32[](2);
        ago[0] = uint32(C.TWAP_WINDOW);
        ago[1] = 0;
        (int56[] memory cumulatives,) = IUniswapV3PoolLike(pool).observe(ago);
        // Upcast before subtracting. The int56 cumulative is allowed to wrap; the delta is not.
        int256 delta = int256(cumulatives[1]) - int256(cumulatives[0]);
        int256 window = int256(uint256(C.TWAP_WINDOW));
        int256 mean = delta / window;
        // Round toward -infinity so a negative partial tick is not truncated toward zero.
        if (delta < 0 && delta % window != 0) mean -= 1;
        if (mean < int256(TickMath.MIN_TICK) || mean > int256(TickMath.MAX_TICK)) revert BadTwap();
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(int24(mean));
        // Keep the Q64.96 fraction. Dividing by 2^192 first floors a 1.02 price to 1.
        priceWad = priceFromSqrt(sqrtPriceX96, coin0, coinDec, quoteDec);
        if (priceWad == 0) revert BadTwap();

        uint256 coinBal = _norm(IERC20(coin).balanceOf(pool), coinDec);
        uint256 quoteBal = _norm(IERC20(quote).balanceOf(pool), quoteDec);
        tvlWad = Math.mulDiv(coinBal, priceWad, C.WAD) + quoteBal;
    }

    /// @dev Mean tick over `TWAP_WINDOW` from two cumulatives. Zero when the mean is not a tick.
    function priceFromDelta(int56 newer, int56 older, bool coin0, uint8 coinDec, uint8 quoteDec)
        internal
        pure
        returns (uint256)
    {
        int256 delta = int256(newer) - int256(older);
        int256 window = int256(uint256(C.TWAP_WINDOW));
        int256 mean = delta / window;
        if (delta < 0 && delta % window != 0) mean -= 1;
        if (mean < int256(TickMath.MIN_TICK) || mean > int256(TickMath.MAX_TICK)) return 0;
        return priceFromSqrt(TickMath.getSqrtPriceAtTick(int24(mean)), coin0, coinDec, quoteDec);
    }

    /// @dev quote-per-coin in WAD. `coin0` means the coin is token0 (the quote is token1).
    function priceFromSqrt(uint160 sqrtPriceX96, bool coin0, uint8 coinDec, uint8 quoteDec)
        internal
        pure
        returns (uint256)
    {
        return _priceWad(sqrtPriceX96, coin0, coinDec, quoteDec);
    }

    function _priceWad(uint160 sqrtPriceX96, bool coin0, uint8 coinDec, uint8 quoteDec) private pure returns (uint256) {
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 q96 = uint256(1) << 96;
        if (coin0) {
            // token1/token0 = sqrt^2 / 2^192, then shift to 18-dec quote per 18-dec coin.
            uint256 scale = 10 ** (uint256(coinDec) + 18 - quoteDec);
            return Math.mulDiv(Math.mulDiv(sqrtP, sqrtP, q96), scale, q96);
        }
        // Coin is token1, so invert. price = 2^192 / (sqrt^2) scaled the same way.
        uint256 num = 10 ** (uint256(coinDec) + 18);
        uint256 den = 10 ** uint256(quoteDec);
        uint256 inv = Math.mulDiv(Math.mulDiv(num, q96, sqrtP), q96, sqrtP);
        return inv / den;
    }

    function _norm(uint256 raw, uint8 dec) private pure returns (uint256) {
        if (dec == 18) return raw;
        return raw * 10 ** (18 - dec);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {DevToken} from "../Deploy.s.sol";

interface ITnPricer {
    function owner() external view returns (address);
    function usdg() external view returns (address);
    function setAllowedQuote(address quote, bool allowed) external;
    function setPriceRoute(address quote, PoolKey[] calldata keys) external;
}

interface ITnRouter {
    function owner() external view returns (address);
    function usdg() external view returns (address);
    function setUsdgRoute(address quote, PoolKey[] calldata keys) external;
}

/// @notice Robinhood TESTNET 46630 only. Adds a DELTA stand-in to the existing launch-pair set, the same way as the
///         other coins: a `DevToken` (18 decimals) and a hookless USDG/DELTA v4 pool seeded through the existing
///         `PoolModifyLiquidityTest` helper. Fee 19900 / tickSpacing 199, matching mainnet after #462. Price is
///         about $0.007857, from the mainnet pool's ~27.5K USDG / ~3.5M DELTA on Nov 17, 2026. Depth is $250,000
///         per side, full range, like the other ERC-20 testnet pools.
contract SeedTestnetDelta is Script {
    using PoolIdLibrary for PoolKey;

    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D;
    address constant PRICER = 0x5dD0F529C215C610f9498f4DaE0d7f36B49fd573;
    address constant ROUTER = 0xb8F4356759F7Bc1351f2D36037AD69ed82b8D839;
    uint256 constant ERC20_POOL_USD = 250_000;
    uint256 constant DELTA_USD = 7_857e12; // $0.007857 per whole token
    uint24 constant FEE = 19_900;
    int24 constant TS = 199;

    function _key(address a, address b, uint24 fee, int24 ts) internal pure returns (PoolKey memory) {
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, ts, IHooks(address(0)));
    }

    function _dec(address t) internal pure returns (uint256) {
        return t == USDG ? 6 : 18;
    }

    function _usdOf(address t) internal pure returns (uint256) {
        return t == USDG ? 1e18 : DELTA_USD;
    }

    function _sqrtP(PoolKey memory k) internal pure returns (uint160) {
        address c0 = Currency.unwrap(k.currency0);
        address c1 = Currency.unwrap(k.currency1);
        uint256 num = _usdOf(c0) * 10 ** _dec(c1);
        uint256 den = _usdOf(c1) * 10 ** _dec(c0);
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
    }

    function _liq(PoolKey memory k, uint160 sqrtP, uint256 usd) internal pure returns (uint128) {
        address c0 = Currency.unwrap(k.currency0);
        return uint128(Math.mulDiv(usd * 10 ** _dec(c0) * 1e18, sqrtP, _usdOf(c0) << 96));
    }

    function run() external {
        require(block.chainid == 46630, "testnet 46630 only");
        require(ITnPricer(PRICER).usdg() == USDG && ITnRouter(ROUTER).usdg() == USDG, "usdg mismatch");
        address me = msg.sender;
        require(ITnPricer(PRICER).owner() == me && ITnRouter(ROUTER).owner() == me, "sender is not the owner");

        string memory rec = vm.readFile("./deployments/testnet-launch-coins.json");
        PoolModifyLiquidityTest lp = PoolModifyLiquidityTest(payable(vm.parseJsonAddress(rec, ".liquidityHelper")));
        require(address(lp) == 0xdD261CD08DD14A64C0f7C242F15F750816ce540A, "unexpected liquidity helper");

        vm.startBroadcast();
        address t = address(new DevToken("Delta (test)", "DELTA", 18, me, 1e27));
        IERC20(USDG).approve(address(lp), type(uint256).max);
        IERC20(t).approve(address(lp), type(uint256).max);

        PoolKey memory k = _key(USDG, t, FEE, TS);
        uint160 sp = _sqrtP(k);
        IPoolManager(PM).initialize(k, sp);
        uint128 L = _liq(k, sp, ERC20_POOL_USD);
        lp.modifyLiquidity(
            k,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(k.tickSpacing),
                tickUpper: TickMath.maxUsableTick(k.tickSpacing),
                liquidityDelta: int256(uint256(L)),
                salt: 0
            }),
            ""
        );

        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = k;
        ITnPricer(PRICER).setAllowedQuote(t, true);
        ITnPricer(PRICER).setPriceRoute(t, keys);
        ITnRouter(ROUTER).setUsdgRoute(t, keys);
        vm.stopBroadcast();

        bytes32 poolId = PoolId.unwrap(k.toId());
        console2.log("DELTA", t);
        console2.log("poolId", vm.toString(poolId));
        console2.log("currency0", Currency.unwrap(k.currency0));
        console2.log("currency1", Currency.unwrap(k.currency1));
        console2.log("sqrtPriceX96", vm.toString(uint256(sp)));
        console2.log("liquidity", vm.toString(uint256(L)));
        console2.log("tick", vm.toString(TickMath.getTickAtSqrtPrice(sp)));
        console2.log("liquidityHelper", address(lp));
    }
}

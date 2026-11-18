// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Regression for audit 2026-11-14 LB-01: a whitelisted ("listed") quote used to be priced from LIVE SPOT at launch,
// so a pump of its route pool around Launchpad.launch baked a wrong quote/USD price into the curve forever. Listed
// routes are now priced from per-pool TWAPs written by the keeper.
// Place in contracts/test/ and run: forge test --match-contract LB01_ListedQuoteSpotAtLaunch -vv

import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract LB01_ListedQuoteSpotAtLaunch is IntegrationBase {
    address internal attacker = makeAddr("attacker");

    /// @dev exactly what script/whitelist/README.md tells the owner to do (1-hop route = the same ref pool here)
    function _whitelistStrategy() internal {
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = strategyUsdgKey;
        vm.startPrank(owner);
        pricer.setAllowedQuote(address(strategy), true);
        pricer.setPriceRoute(address(strategy), keys);
        vm.stopPrank();
    }

    function _swap(address from, address tokenIn, uint256 amountIn) internal {
        PoolKey memory key = strategyUsdgKey;
        bool zeroForOne = Currency.unwrap(key.currency0) == tokenIn;
        vm.startPrank(from);
        IERC20(tokenIn).approve(address(swapRouter), amountIn);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _launchStrategy(address who) internal returns (BondingCurve) {
        vm.prank(who);
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(
            ILaunchpad.LaunchParams({
                name: "Coin",
                ticker: "C",
                imageURI: "ipfs://img",
                description: "",
                socialsURI: "",
                quote: address(strategy),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: vm.getBlockTimestamp() + 1 days
            })
        );
        return BondingCurve(r.curve);
    }

    function _next(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function test_LB01_pumpedRouteAtLaunch_isNotBaked() public {
        _whitelistStrategy();
        for (uint256 i; i < 6; ++i) {
            _next(300);
            pricer.poke(address(strategy)); // keeper (the cron pokes every minute)
        }
        uint256 fair = pricer.quotePriceUsd(address(strategy));
        assertApproxEqRel(fair, 1e18, 0.0001e18, "STRATEGY = $1");

        uint256 pump = 60_000 * U;
        quote.mint(attacker, pump);
        _swap(attacker, address(quote), pump);
        assertGt(pricer.spotPriceUsd(address(strategy)), 2 * fair, "spot is pumped");
        BondingCurve evil = _launchStrategy(attacker);
        _swap(attacker, address(strategy), strategy.balanceOf(attacker));
        assertApproxEqRel(evil.quotePriceUsd(), fair, 0.001e18, "launch baked the TWAP, not the pumped spot");
    }

    /// A pump held across keeper pokes moves the listed price at most 200 ticks (~2%) per poke.
    function test_LB01_heldPump_movesListedPriceSlowly() public {
        _whitelistStrategy();
        _next(1800);
        pricer.poke(address(strategy));
        uint256 fair = pricer.quotePriceUsd(address(strategy));
        quote.mint(attacker, 60_000 * U);
        _swap(attacker, address(quote), 60_000 * U);
        for (uint256 i; i < 3; ++i) {
            _next(60);
            pricer.poke(address(strategy));
        }
        assertLt(pricer.quotePriceUsd(address(strategy)), fair * 102 / 100, "3 min held: under 2%");
    }

    /// 2-hop listed routes are TWAP-priced too (per-pool route oracles).
    function test_LB01_routeOracle_isWrittenByKeeperOnly() public {
        _whitelistStrategy();
        (int24 t0,) = pricer.routeTwapTick(strategyUsdgKey);
        quote.mint(attacker, 60_000 * U);
        _swap(attacker, address(quote), 60_000 * U);
        _next(60);
        vm.prank(attacker);
        pricer.poke(address(strategy)); // not a keeper: no-op
        _next(1800);
        (int24 t1,) = pricer.routeTwapTick(strategyUsdgKey);
        assertEq(t1, t0, "stranger's poke recorded nothing");
    }
}

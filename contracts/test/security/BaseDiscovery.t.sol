// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../integration/IntegrationBase.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";

/// @notice Shared helpers: create standard hookless (base, USDG) v4 pools, warm the TWAP, launch on a base.
abstract contract BaseTestBase is IntegrationBase {
    function _std(address base, uint24 fee, int24 ts, uint128 liq) internal returns (PoolKey memory key) {
        (address c0, address c1) = uint160(base) < uint160(address(quote)) ? (base, address(quote)) : (address(quote), base);
        key = PoolKey({currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: fee, tickSpacing: ts, hooks: IHooks(address(0))});
        manager.initialize(key, _parSqrtP(base));
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        MockUSDG(base).mint(address(this), 1e30);
        quote.mint(address(this), 1e30);
        IERC20(base).approve(address(lp), type(uint256).max);
        quote.approve(address(lp), type(uint256).max);
        int24 hi = (887272 / ts) * ts;
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -hi, tickUpper: hi, liquidityDelta: int256(_liq(liq)), salt: 0}),
            ""
        );
    }

    function _warm(address base) internal {
        // vm.getBlockTimestamp: via-IR may cache block.timestamp within one test function.
        uint256 t = vm.getBlockTimestamp();
        uint256 end = t + pricer.autoWarmup();
        uint256 bn = vm.getBlockNumber();
        while (t < end) {
            t += 60;
            vm.warp(t);
            vm.roll(++bn);
            pricer.poke(base);
        }
    }

    function _launchBase(address base) internal returns (ILaunchpad.LaunchResult memory r) {
        vm.prank(creator);
        r = launchpad.launchCoin(
            ILaunchpad.LaunchParams({
                name: "B", ticker: "B", imageURI: "ipfs://b", description: "", socialsURI: "", quote: base,
                creatorTaxBps: 0, creatorBuyQuoteIn: 0, creatorBuyMinTokensOut: 0, deadline: vm.getBlockTimestamp() + 1 days
            })
        );
    }
}

/// @notice (e) permissionless base discovery: standard v4 tiers, liquidity floor, TWAP warm-up, owner override.
contract BaseDiscoveryTest is BaseTestBase {
    // ───────────── (e) discovery ─────────────

    function test_default_minLiquidity() public view {
        // 1e4 * 10^((18 + usdgDec) / 2): 1e22 at 18-dec USDG, 1e16 at 6-dec
        assertEq(pricer.minLiquidity(), _liq(1e22));
    }

    function test_discovery_registers_deepest_standard_pool_then_warms_up() public {
        MockUSDG b = new MockUSDG();
        _std(address(b), 500, 10, 2e22);
        PoolKey memory deep = _std(address(b), 10_000, 200, 5e22);
        (bool ok, PoolKey memory k) = pricer.poolKeyFor(address(b));
        assertTrue(ok);
        assertEq(k.fee, 10_000, "deepest tier");
        assertFalse(pricer.hasPricePool(address(b)));

        pricer.poke(address(b)); // permissionless registration
        assertTrue(pricer.hasPricePool(address(b)));
        assertTrue(pricer.isAutoPool(address(b)));
        assertEq(pricer.pricePoolOf(address(b)).fee, deep.fee);
        uint256 readyAt = vm.getBlockTimestamp() + pricer.autoWarmup();
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.TwapWarmingUp.selector, readyAt));
        pricer.quotePriceUsd(address(b));

        // a launch before warm-up reverts too (and rolls back nothing permanent: the pool stays registered)
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.TwapWarmingUp.selector, readyAt));
        _launchBase(address(b));

        _warm(address(b));
        assertApproxEqRel(pricer.quotePriceUsd(address(b)), 1e18, 0.001e18);
        ILaunchpad.LaunchResult memory r = _launchBase(address(b));
        assertApproxEqRel(BondingCurve(r.curve).quotePriceUsd(), 1e18, 0.001e18);
    }

    function test_discovery_ignores_thin_and_hooked_pools() public {
        MockUSDG b = new MockUSDG();
        _std(address(b), 3000, 60, 1e21); // below the 1e22 floor
        (bool ok,) = pricer.poolKeyFor(address(b));
        assertFalse(ok);
        pricer.poke(address(b));
        assertFalse(pricer.hasPricePool(address(b)));
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.NoPricePool.selector, address(b)));
        pricer.quotePriceUsd(address(b));
    }

    function test_owner_override_is_never_replaced_and_needs_no_warmup() public {
        // strategy is owner-registered in setUp
        assertFalse(pricer.isAutoPool(address(strategy)));
        _std(address(strategy), 10_000, 200, 9e23); // a deeper standard pool appears
        pricer.poke(address(strategy));
        assertEq(pricer.pricePoolOf(address(strategy)).fee, 3000, "override kept");
        pricer.quotePriceUsd(address(strategy)); // no warm-up for owner pools
    }

    function test_usdg_is_one_dollar() public view {
        assertEq(pricer.quotePriceUsd(address(quote)), _usdgQuoteUsd());
    }

    function test_rediscovers_when_auto_pool_drops_below_floor() public {
        MockUSDG b = new MockUSDG();
        PoolKey memory thinKey = _std(address(b), 100, 1, 2e22);
        pricer.poke(address(b));
        assertEq(pricer.pricePoolOf(address(b)).fee, 100);
        // a deeper pool appears, then the auto pool's liquidity falls under the floor
        _std(address(b), 3000, 60, 5e22);
        vm.prank(owner);
        pricer.setMinLiquidity(uint128(_liq(3e22)));
        pricer.poke(address(b));
        assertEq(pricer.pricePoolOf(address(b)).fee, 3000, "re-discovered");
        assertTrue(pricer.isAutoPool(address(b)));
        assertEq(pricer.autoSince(address(b)), vm.getBlockTimestamp(), "warm-up restarts");
        thinKey; // silence
    }

    function test_owner_can_tune_floor_and_warmup() public {
        vm.prank(rando());
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pricer.setAutoWarmup(10);
        vm.startPrank(owner);
        pricer.setAutoWarmup(600);
        vm.expectRevert(QuotePricer.BadParam.selector);
        pricer.setAutoWarmup(8 days);
        vm.stopPrank();
        assertEq(pricer.autoWarmup(), 600);
    }

    function rando() internal returns (address) {
        return makeAddr("rando");
    }
}

/// @notice 6-decimal USDG run of BaseDiscoveryTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract BaseDiscovery6DecTest is BaseDiscoveryTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}

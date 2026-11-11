// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase, MockUSDG} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {IQuoteProbe} from "../../src/interfaces/IQuoteProbe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {FeeTakingHook} from "@uniswap/v4-core/src/test/FeeTakingHook.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @dev afterSwap fee-taking hook that also seeds a dynamic LP fee on initialize (SPACEHOOD-shaped).
contract DynamicFeeTakingHook is FeeTakingHook {
    IPoolManager private immutable pm;
    uint24 public immutable lpFee;

    constructor(IPoolManager manager_, uint24 lpFee_) FeeTakingHook(manager_) {
        pm = manager_;
        lpFee = lpFee_;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24) external override returns (bytes4) {
        pm.updateDynamicLPFee(key, lpFee);
        return IHooks.afterInitialize.selector;
    }
}

/// @notice 1-hop and 2-hop USDG routes, including a hooked dynamic-fee second hop, pre- and post-graduation.
contract UsdgRouteTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;

    MockUSDG internal mid;
    MockUSDG internal stock;
    PoolKey internal usdgMidKey;
    PoolKey internal midStockKey;
    PoolKey internal midStockHookedKey;
    DynamicFeeTakingHook internal feeHook;
    BondingCurve internal sCurve; // stock-quoted coin (two USDG hops)
    Token internal sTok;
    BondingCurve internal uCurve; // USDG-quoted coin (no USDG hop)
    Token internal uTok;
    address internal alice = makeAddr("aliceRoute");

    function setUp() public override {
        super.setUp();
        mid = new MockUSDG();
        stock = new MockUSDG();
        usdgMidKey = _initRefPool(address(mid), address(quote), uint160(1) << 96);
        midStockKey = _initRefPool(address(mid), address(stock), uint160(1) << 96);

        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory ctorArgs = abi.encode(manager, uint24(7000)); // 0.70%
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(DynamicFeeTakingHook).creationCode, ctorArgs);
        feeHook = new DynamicFeeTakingHook{salt: salt}(manager, 7000);
        require(address(feeHook) == hookAddr, "hook addr");

        midStockHookedKey = _initHookedPool(address(mid), address(stock), uint160(1) << 96, IHooks(address(feeHook)));

        router.setUsdgRouting(address(quote), address(launchpad));
        (uCurve, uTok) = _launchWithQuote(address(quote), 0, 0);
        _warpPastSnipe();
        quote.mint(alice, 1_000_000 ether);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _initHookedPool(address a, address b, uint160 sqrtP, IHooks hooks)
        internal
        returns (PoolKey memory key)
    {
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 8,
            hooks: hooks
        });
        manager.initialize(key, sqrtP);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        MockUSDG(a).mint(address(this), 1e30);
        MockUSDG(b).mint(address(this), 1e30);
        IERC20(a).approve(address(lp), type(uint256).max);
        IERC20(b).approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: -887256, tickUpper: 887256, liquidityDelta: 100_000 ether, salt: 0
            }),
            ""
        );
    }

    function _priceAndRoute(PoolKey memory hop0, PoolKey memory hop1) internal {
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = hop0;
        keys[1] = hop1;
        router.setUsdgRoute(address(stock), keys);
        vm.startPrank(owner);
        pricer.setAllowedQuote(address(stock), true);
        pricer.setPriceRoute(address(stock), keys);
        vm.stopPrank();
    }

    function _launchStockCoin() internal {
        (sCurve, sTok) = _launchWithQuote(address(stock), 0, 0);
        _warpPastSnipe();
        vm.startPrank(alice);
        sTok.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _wireHooklessRoute() internal {
        _priceAndRoute(usdgMidKey, midStockKey);
        _launchStockCoin();
    }

    function _wireHookedRoute() internal {
        _priceAndRoute(usdgMidKey, midStockHookedKey);
        _launchStockCoin();
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function _noDust() internal view {
        assertEq(quote.balanceOf(address(router)), 0, "router usdg dust");
        assertEq(mid.balanceOf(address(router)), 0, "router mid dust");
        assertEq(stock.balanceOf(address(router)), 0, "router quote dust");
        if (address(sTok) != address(0)) assertEq(sTok.balanceOf(address(router)), 0, "router token dust");
    }

    function test_setUsdgPool_still_registers_one_hop() public {
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        PoolKey memory k = router.usdgPoolOf(address(strategy));
        assertEq(k.fee, strategyUsdgKey.fee);
        assertEq(Currency.unwrap(k.currency0), Currency.unwrap(strategyUsdgKey.currency0));
        PoolKey[] memory r = router.usdgRouteOf(address(strategy));
        assertEq(r.length, 1);
    }

    function test_setUsdgRoute_rejects_disciple_hook() public {
        PoolKey memory bad = usdgMidKey;
        bad.hooks = IHooks(hook);
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = bad;
        // wrong pairing + disciple hook → BadPool
        vm.expectRevert(DiscipleRouter.BadPool.selector);
        router.setUsdgRoute(address(stock), keys);
    }

    function test_setUsdgRoute_keeps_dynamic_fee_flag_and_hook() public {
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = usdgMidKey;
        keys[1] = midStockHookedKey;
        router.setUsdgRoute(address(stock), keys);
        PoolKey[] memory got = router.usdgRouteOf(address(stock));
        assertEq(got.length, 2);
        assertEq(got[1].fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);
        assertEq(address(got[1].hooks), address(feeHook));
        assertEq(got[1].tickSpacing, 8);
        // first hop is the USDG-touching pool
        assertEq(Currency.unwrap(router.usdgPoolOf(address(stock)).currency0), Currency.unwrap(usdgMidKey.currency0));
    }

    function test_curve_two_hop_buy_sell() public {
        _wireHooklessRoute();
        (uint256 qBuy,) = router.quoteBuyWithUsdg(address(sTok), 100 ether);
        uint256 u0 = quote.balanceOf(alice);
        uint256 t0 = sTok.balanceOf(alice);
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 out = router.buyWithUsdg(address(sTok), 100 ether, qBuy, _dl());
        uint256 gasBuy = g - gasleft();
        assertEq(out, qBuy);
        assertEq(u0 - quote.balanceOf(alice), 100 ether);
        assertEq(sTok.balanceOf(alice) - t0, out);
        _noDust();

        uint256 bal = sTok.balanceOf(alice) / 2;
        (uint256 qSell,) = router.quoteSellToUsdg(address(sTok), bal);
        vm.prank(alice);
        g = gasleft();
        uint256 usdgOut = router.sellToUsdg(address(sTok), bal, qSell, _dl());
        uint256 gasSell = g - gasleft();
        assertEq(usdgOut, qSell);
        assertGt(usdgOut, 0);
        _noDust();
        console2.log("gas buyWithUsdg curve 2-hop hookless", gasBuy);
        console2.log("gas sellToUsdg curve 2-hop hookless", gasSell);
    }

    function test_curve_two_hop_hooked_dynamic_fee_min_out_is_real_output() public {
        _wireHookedRoute();
        (uint256 qBuy,) = router.quoteBuyWithUsdg(address(sTok), 100 ether);
        assertGt(qBuy, 0);
        uint256 t0 = sTok.balanceOf(alice);
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 out = router.buyWithUsdg(address(sTok), 100 ether, qBuy, _dl());
        uint256 gasBuy = g - gasleft();
        assertEq(out, qBuy, "min-out / quote uses hook-adjusted output");
        assertEq(sTok.balanceOf(alice) - t0, out);
        _noDust();

        uint256 bal = sTok.balanceOf(alice) / 2;
        (uint256 qSell,) = router.quoteSellToUsdg(address(sTok), bal);
        vm.prank(alice);
        g = gasleft();
        uint256 usdgOut = router.sellToUsdg(address(sTok), bal, qSell, _dl());
        uint256 gasSell = g - gasleft();
        assertEq(usdgOut, qSell);
        assertGt(usdgOut, 0);
        _noDust();
        // hook kept 1.23% of the unspecified token on the mid/stock hop
        assertGt(stock.balanceOf(address(feeHook)) + mid.balanceOf(address(feeHook)), 0, "hook took afterSwap fee");
        console2.log("gas buyWithUsdg curve 2-hop hooked", gasBuy);
        console2.log("gas sellToUsdg curve 2-hop hooked", gasSell);
    }

    function test_grad_two_hop_hooked_still_works() public {
        _wireHookedRoute();
        // seed stock into alice so graduation buyers (who pay in stock) can be funded
        stock.mint(address(this), 0);
        _graduateWith(sCurve, stock);
        (uint256 qBuy,) = router.quoteBuyWithUsdg(address(sTok), 100 ether);
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 out = router.buyWithUsdg(address(sTok), 100 ether, qBuy, _dl());
        uint256 gasBuy = g - gasleft();
        assertEq(out, qBuy);
        _noDust();
        uint256 bal = sTok.balanceOf(alice) / 2;
        (uint256 qSell,) = router.quoteSellToUsdg(address(sTok), bal);
        vm.prank(alice);
        g = gasleft();
        uint256 usdgOut = router.sellToUsdg(address(sTok), bal, qSell, _dl());
        uint256 gasSell = g - gasleft();
        assertEq(usdgOut, qSell);
        _noDust();
        console2.log("gas buyWithUsdg v4 2-hop-quote + coin hooked", gasBuy);
        console2.log("gas sellToUsdg v4 2-hop-quote + coin hooked", gasSell);
    }

    function test_usdg_quoted_single_hop_unchanged() public {
        (uint256 qBuy,) = router.quoteBuyWithUsdg(address(uTok), 100 ether);
        vm.prank(alice);
        uint256 g = gasleft();
        uint256 out = router.buyWithUsdg(address(uTok), 100 ether, qBuy, _dl());
        uint256 gasBuy = g - gasleft();
        assertEq(out, qBuy);
        console2.log("gas buyWithUsdg curve 1-hop usdg-quote", gasBuy);
    }
}

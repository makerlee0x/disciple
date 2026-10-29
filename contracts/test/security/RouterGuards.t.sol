// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";

/// @notice DiscipleRouter slippage guards: minOut != 0 and a hard per-swap price-impact cap (default 50%).
contract RouterGuardsTest is IntegrationBase {
    BondingCurve curve;
    Token tok;
    address whale = makeAddr("whale");

    function setUp() public override {
        super.setUp();
        (curve, tok) = _launch(0, 0);
        _graduate(curve);
        quote.mint(whale, 10_000_000 ether);
        deal(address(tok), whale, 1_000_000_000 ether);
        vm.startPrank(whale);
        quote.approve(address(router), type(uint256).max);
        tok.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function test_defaults() public view {
        assertEq(router.maxImpactBps(), 5000);
        assertTrue(router.owner() != address(0));
    }

    function test_zeroMinOutReverts() public {
        vm.startPrank(whale);
        vm.expectRevert(DiscipleRouter.ZeroMinOut.selector);
        router.buyExactIn(address(tok), 1 ether, 0, whale, block.timestamp + 1);
        vm.expectRevert(DiscipleRouter.ZeroMinOut.selector);
        router.sellExactIn(address(tok), 1000 ether, 0, whale, block.timestamp + 1);
        vm.stopPrank();
    }

    function test_smallTradeWithinCap() public {
        (, uint256 impact,) = router.quoteExactIn(address(tok), true, 10 ether);
        assertLt(impact, 5000);
        vm.prank(whale);
        assertGt(router.buyExactIn(address(tok), 10 ether, 1, whale, block.timestamp + 1), 0);
    }

    function test_hugeBuyRevertsOnImpact() public {
        (, uint256 impact,) = router.quoteExactIn(address(tok), true, 20_000 ether);
        assertGt(impact, 5000);
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(DiscipleRouter.PriceImpactTooHigh.selector, impact, 5000));
        router.buyExactIn(address(tok), 20_000 ether, 1, whale, block.timestamp + 1);
    }

    /// Sells are bounded below -100% and the LP is deep, so test the sell path with a tighter owner-set cap (10%).
    function test_hugeSellRevertsOnImpact() public {
        vm.prank(router.owner());
        router.setMaxImpactBps(1000);
        uint256 amt = 1_000_000 ether;
        uint256 impact;
        while (amt <= 1_000_000_000 ether) {
            (, impact,) = router.quoteExactIn(address(tok), false, amt);
            if (impact > 1000) break;
            amt *= 2;
        }
        assertGt(impact, 1000, "no sell size reaches 10% impact");
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(DiscipleRouter.PriceImpactTooHigh.selector, impact, 1000));
        router.sellExactIn(address(tok), amt, 1, whale, block.timestamp + 1);
    }

    function test_ownerCanRaiseCapWithinBounds() public {
        address o = router.owner();
        vm.prank(whale);
        vm.expectRevert(DiscipleRouter.OnlyOwner.selector);
        router.setMaxImpactBps(9000);
        vm.startPrank(o);
        vm.expectRevert(DiscipleRouter.BadParam.selector);
        router.setMaxImpactBps(99);
        vm.expectRevert(DiscipleRouter.BadParam.selector);
        router.setMaxImpactBps(100_001);
        router.setMaxImpactBps(100_000);
        vm.stopPrank();
        vm.prank(whale);
        assertGt(router.buyExactIn(address(tok), 10_000 ether, 1, whale, block.timestamp + 1), 0); // < 1000% impact on the steep-curve pool
    }

    function test_transferOwnership() public {
        address o = router.owner();
        vm.prank(o);
        router.transferOwnership(whale);
        assertEq(router.owner(), whale);
        vm.prank(o);
        vm.expectRevert(DiscipleRouter.OnlyOwner.selector);
        router.setMaxImpactBps(1000);
    }
}

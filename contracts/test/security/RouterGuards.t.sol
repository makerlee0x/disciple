// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";

/// @notice DiscipleRouter slippage guards: minOut != 0. Pool swaps have no price-impact cap (curve trades only).
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

    function test_smallTradeFills() public {
        (, uint256 impact,) = router.quoteExactIn(address(tok), true, 10 ether);
        assertLt(impact, 5000);
        vm.prank(whale);
        assertGt(router.buyExactIn(address(tok), 10 ether, 1, whale, block.timestamp + 1), 0);
    }

    /// maker 2026-11-19: no size / price-move cap on pool swaps; a huge buy goes through at its quote.
    function test_hugeBuyNotCapped() public {
        (uint256 q, uint256 impact,) = router.quoteExactIn(address(tok), true, 20_000 ether);
        assertGt(impact, 5000);
        vm.prank(whale);
        assertEq(router.buyExactIn(address(tok), 20_000 ether, 1, whale, block.timestamp + 1), q);
    }

    /// Same for sells: a dump of any size fills (minOut is the only guard).
    function test_hugeSellNotCapped() public {
        uint256 bal = tok.balanceOf(whale);
        vm.prank(whale);
        uint256 got = router.buyExactIn(address(tok), 20_000 ether, 1, whale, block.timestamp + 1);
        (uint256 q, uint256 impact,) = router.quoteExactIn(address(tok), false, got);
        assertGt(impact, 1000);
        vm.prank(whale);
        assertEq(router.sellExactIn(address(tok), got, 1, whale, block.timestamp + 1), q);
        assertEq(tok.balanceOf(whale), bal);
    }

    function test_transferOwnership() public {
        address o = router.owner();
        vm.prank(o);
        router.transferOwnership(whale);
        assertEq(router.owner(), o, "two-step: nominee must accept");
        vm.prank(o);
        vm.expectRevert(DiscipleRouter.OnlyOwner.selector);
        router.acceptOwnership();
        vm.prank(whale);
        router.acceptOwnership();
        assertEq(router.owner(), whale);
        vm.prank(o);
        vm.expectRevert(DiscipleRouter.OnlyOwner.selector);
        router.removeUsdgPool(address(1));
    }
}

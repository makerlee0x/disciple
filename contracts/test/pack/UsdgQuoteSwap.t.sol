// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Redeploy pack item 2: DiscipleRouter.swapUsdgToQuote / swapQuoteToUsdg on the registered USDG/quote pool.
contract UsdgQuoteSwapTest is IntegrationBase {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        quote.mint(alice, 1_000_000 ether);
        strategy.mint(alice, 1_000_000_000 ether);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        strategy.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function _noDust() internal view {
        assertEq(quote.balanceOf(address(router)), 0, "router usdg dust");
        assertEq(strategy.balanceOf(address(router)), 0, "router quote dust");
    }

    function test_swapUsdgToQuote_matches_quote_and_pays_recipient() public {
        (uint256 q,) = router.quoteUsdgQuoteSwap(address(strategy), true, 10 ether);
        assertGt(q, 0);
        uint256 u0 = quote.balanceOf(alice);
        vm.prank(alice);
        uint256 out = router.swapUsdgToQuote(address(strategy), 10 ether, q, bob, _dl());
        assertEq(out, q, "exact quote");
        assertEq(strategy.balanceOf(bob), out, "recipient gets the pair coin");
        assertEq(u0 - quote.balanceOf(alice), 10 ether, "payer pays USDG");
        _noDust();
    }

    function test_swapQuoteToUsdg_matches_quote_and_pays_recipient() public {
        (uint256 q,) = router.quoteUsdgQuoteSwap(address(strategy), false, 1000 ether);
        assertGt(q, 0);
        uint256 s0 = strategy.balanceOf(alice);
        uint256 b0 = quote.balanceOf(bob);
        vm.prank(alice);
        uint256 out = router.swapQuoteToUsdg(address(strategy), 1000 ether, q, bob, _dl());
        assertEq(out, q);
        assertEq(quote.balanceOf(bob) - b0, out, "recipient gets USDG");
        assertEq(s0 - strategy.balanceOf(alice), 1000 ether);
        _noDust();
    }

    function test_roundTrip_loses_only_pool_fees() public {
        vm.startPrank(alice);
        uint256 s = router.swapUsdgToQuote(address(strategy), 100 ether, 1, alice, _dl());
        uint256 u = router.swapQuoteToUsdg(address(strategy), s, 1, alice, _dl());
        vm.stopPrank();
        assertLt(u, 100 ether);
        assertGt(u, 98 ether, "two pool fees + tiny impact");
    }

    function test_minOut_slippage_reverts() public {
        (uint256 q,) = router.quoteUsdgQuoteSwap(address(strategy), true, 10 ether);
        vm.prank(alice);
        vm.expectRevert(DiscipleRouter.Slippage.selector);
        router.swapUsdgToQuote(address(strategy), 10 ether, q + 1, alice, _dl());
        (uint256 q2,) = router.quoteUsdgQuoteSwap(address(strategy), false, 1000 ether);
        vm.prank(alice);
        vm.expectRevert(DiscipleRouter.Slippage.selector);
        router.swapQuoteToUsdg(address(strategy), 1000 ether, q2 + 1, alice, _dl());
    }

    function test_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(DiscipleRouter.ZeroMinOut.selector);
        router.swapUsdgToQuote(address(strategy), 1 ether, 0, alice, _dl());
        vm.expectRevert(DiscipleRouter.ZeroAmount.selector);
        router.swapQuoteToUsdg(address(strategy), 0, 1, alice, _dl());
        vm.expectRevert(DiscipleRouter.ZeroRecipient.selector);
        router.swapUsdgToQuote(address(strategy), 1 ether, 1, address(0), _dl());
        vm.expectRevert(DiscipleRouter.Expired.selector);
        router.swapQuoteToUsdg(address(strategy), 1 ether, 1, alice, block.timestamp - 1);
        vm.expectRevert(DiscipleRouter.BadParam.selector);
        router.swapUsdgToQuote(address(quote), 1 ether, 1, alice, _dl()); // USDG→USDG
        address other = makeAddr("unregisteredQuote");
        vm.expectRevert(abi.encodeWithSelector(DiscipleRouter.NoUsdgPool.selector, other));
        router.swapUsdgToQuote(other, 1 ether, 1, alice, _dl());
        vm.stopPrank();
    }

    function test_unconfigured_reverts() public {
        DiscipleRouter fresh = new DiscipleRouter(manager, lockedLP, address(hook));
        vm.expectRevert(DiscipleRouter.UsdgNotConfigured.selector);
        fresh.swapUsdgToQuote(address(strategy), 1 ether, 1, alice, _dl());
        vm.expectRevert(DiscipleRouter.UsdgNotConfigured.selector);
        fresh.quoteUsdgQuoteSwap(address(strategy), true, 1 ether);
    }

    function test_price_impact_cap() public {
        router.setMaxImpactBps(100); // 1%
        vm.prank(alice);
        vm.expectRevert(); // PriceImpactTooHigh(imp, 100)
        router.swapQuoteToUsdg(address(strategy), 500_000_000 ether, 1, alice, _dl());
    }

    function test_reentrancy_lock_is_transient_per_call() public {
        // the lock is released after each call: back-to-back calls in one tx both succeed
        vm.startPrank(alice);
        router.swapUsdgToQuote(address(strategy), 1 ether, 1, alice, _dl());
        router.swapUsdgToQuote(address(strategy), 1 ether, 1, alice, _dl());
        vm.stopPrank();
        _noDust();
    }

    function testFuzz_swapUsdgToQuote(uint96 amt) public {
        uint256 a = bound(uint256(amt), 1e6, 10_000 ether);
        (uint256 q,) = router.quoteUsdgQuoteSwap(address(strategy), true, a);
        vm.assume(q > 0);
        vm.prank(alice);
        assertEq(router.swapUsdgToQuote(address(strategy), a, q, alice, _dl()), q);
        _noDust();
    }
}

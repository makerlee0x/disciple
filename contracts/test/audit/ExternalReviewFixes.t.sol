// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Regression tests for the external review round of 2026-11-14 (contracts/docs/audit-2026-11-14.md, "External
// reviews"). N-1 / N-2 PoCs adapted from the reviewer's AuditPoC2.t.sol.

import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {TwapOracle} from "../../src/libraries/TwapOracle.sol";
import {Test} from "forge-std/Test.sol";

contract TwapHarness {
    TwapOracle.State internal s;

    function write(int24 t) external {
        TwapOracle.write(s, t, 0, true);
    }

    function consult(uint32 w) external view returns (int24 t) {
        (t,) = TwapOracle.consult(s, w, TwapOracle.last(s).tick);
    }
}

/// F-L7 with the reviewer's numbers: tick -270,000, a 7-day gap, window start mid-segment.
contract TwapLongGapTest is Test {
    function test_F_L7_interpolationAfter7Days() public {
        TwapHarness h = new TwapHarness();
        vm.warp(1_800_000_000);
        h.write(-270_000);
        vm.warp(block.timestamp + 7 days);
        h.write(-270_000);
        vm.warp(block.timestamp + 600);
        assertEq(h.consult(4 days), -270_000);
    }
}

contract ExternalReviewFixesTest is IntegrationBase {
    function _params(address q) internal view returns (ILaunchpad.LaunchParams memory p) {
        p = ILaunchpad.LaunchParams({
            name: "PoC", ticker: "POC", imageURI: "ipfs://img", description: "", socialsURI: "", quote: q,
            creatorTaxBps: 0, creatorBuyQuoteIn: 0, creatorBuyMinTokensOut: 0, deadline: vm.getBlockTimestamp() + 1 days
        });
    }

    /// N-1: the owner can no longer pre-register the next token address and block every launch.
    function test_N1_ownerCannotPreRegisterNextToken() public {
        address next = vm.computeCreateAddress(address(launchpad), vm.getNonce(address(launchpad)));
        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        feeRouter.registerTokenQuote(next, address(quote));
        vm.prank(creator);
        launchpad.launch(_params(address(quote)));
    }

    /// N-2: trusting another router leaves curveRouter alone; replacing it takes an explicit untrust + trust.
    function test_N2_trustDoesNotMoveCurveRouter() public {
        address before = launchpad.curveRouter();
        address other = makeAddr("anotherTrustedRouter");
        vm.startPrank(owner);
        launchpad.setTrustedRouter(other, true);
        assertEq(launchpad.curveRouter(), before, "unchanged");
        launchpad.setTrustedRouter(other, false);
        assertEq(launchpad.curveRouter(), before, "untrusting a non-primary router leaves it");
        launchpad.setTrustedRouter(before, false);
        assertEq(launchpad.curveRouter(), address(0), "untrusting the primary clears it");
        launchpad.setTrustedRouter(other, true);
        assertEq(launchpad.curveRouter(), other, "next trusted router becomes primary");
        vm.stopPrank();
    }

    /// F-M1 decision: only USDG and listed quotes can launch.
    function test_unlistedQuote_cannotLaunch() public {
        MockUSDG odd = new MockUSDG();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.QuoteNotListed.selector, address(odd)));
        launchpad.launch(_params(address(odd)));
        vm.prank(owner);
        pricer.setAllowedQuote(address(strategy), false);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.QuoteNotListed.selector, address(strategy)));
        launchpad.launch(_params(address(strategy)));
    }

    /// F-L9: clearing a listed quote's pool also unlists it.
    function test_clearPricePool_unlists() public {
        assertTrue(pricer.isAllowedQuote(address(strategy)));
        vm.prank(owner);
        pricer.clearPricePool(address(strategy));
        assertFalse(pricer.isAllowedQuote(address(strategy)));
    }

    /// F-L7 end to end on the pricer (small tick here; TwapLongGapTest covers the overflow numbers).
    function test_twap_longGap_doesNotOverflow() public {
        vm.warp(vm.getBlockTimestamp() + 3600);
        vm.roll(vm.getBlockNumber() + 1);
        pricer.poke(address(strategy));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.roll(vm.getBlockNumber() + 1);
        pricer.poke(address(strategy));
        vm.warp(vm.getBlockTimestamp() + 600); // window start falls inside the 7-day segment
        pricer.quotePriceUsd(address(strategy));
    }

    /// F-I7: oracle setters refuse settings that would switch the protections off.
    function test_pricerSetterBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(QuotePricer.BadParam.selector);
        pricer.setTwapParams(60, 100);
        vm.expectRevert(QuotePricer.BadParam.selector);
        pricer.setTwapParams(1800, 5000);
        vm.expectRevert(QuotePricer.BadParam.selector);
        pricer.setMinLiquidity(0);
        vm.stopPrank();
    }
}

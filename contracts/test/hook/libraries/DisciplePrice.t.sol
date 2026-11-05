// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DisciplePrice as P} from "../../../src/hook/libraries/DisciplePrice.sol";

contract PriceHarness {
    function baseLog(uint256 f) external pure returns (uint256) {
        return P.baseLog(f);
    }

    function widenLog(uint256 h0, uint256 age) external pure returns (uint256) {
        return P.widenLog(h0, age);
    }

    function spreadLog(uint256 h0, uint256 age) external pure returns (uint256) {
        return P.spreadLog(h0, age);
    }

    function markupFromLog(uint256 h) external pure returns (uint256) {
        return P.markupFromLog(h);
    }

    function markup(uint256 f, uint256 age) external pure returns (uint256, bool) {
        return P.markup(f, age);
    }

    function recentre(uint256 u, uint256 v) external pure returns (uint256) {
        return P.recentre(u, v);
    }
}

/// Expected values are float reference numbers (python math), checked to ~1e-12 relative.
contract DisciplePriceTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q128 = 1 << 128;
    PriceHarness internal h;
    uint256 internal h0;

    function setUp() public {
        h = new PriceHarness();
        h0 = h.baseLog(3000);
    }

    function test_baseLogIsFee() public view {
        // -ln(0.997) = 0.0030045090202987245
        assertGe(h0, 3004509020298724);
        assertLe(h0, 3004509020298724 + 2000);
        assertEq(h.baseLog(0), 0);
        // exp(h0) covers the same-chain input-fee markup 1/(1-f)
        assertGe(h.markupFromLog(h0), 1003009027081243731);
        assertApproxEqRel(h.markupFromLog(h0), 1003009027081243731, 1e4);
    }

    function test_widenLogShape() public view {
        assertEq(h.widenLog(h0, 0), h0, "fresh");
        assertEq(h.widenLog(h0, 60 minutes), h0, "grace edge: no jump");
        assertApproxEqRel(h.widenLog(h0, 60 minutes + 1), 3033560610597809, 1e6, "one second late");
        assertApproxEqRel(h.widenLog(h0, 90 minutes), 18021515465091604, 1e6, "90 min");
        assertApproxEqRel(h.widenLog(h0, 2 hours), 25308555171404300, 1e6, "2 h");
        assertApproxEqRel(h.markupFromLog(h.widenLog(h0, 2 hours)), 1025631535620432400, 1e6);
    }

    function test_localFade() public view {
        uint256 cap = h.widenLog(h0, 2 hours);
        assertEq(h.spreadLog(h0, 2 hours), cap, "continuous at entry");
        assertApproxEqRel(h.spreadLog(h0, 2 hours + 15 minutes), 14156532095851512, 1e6, "half way");
        assertEq(h.spreadLog(h0, 2 hours + 30 minutes), h0, "faded");
        assertEq(h.spreadLog(h0, 30 days), h0, "stays at base, never stops");
        (uint256 g, bool on) = h.markup(3000, 2 hours - 1);
        assertTrue(on, "band on before local mode");
        assertGt(g, h.markupFromLog(h0));
        (, on) = h.markup(3000, 2 hours);
        assertFalse(on, "band off in local mode");
    }

    function testFuzz_spreadNeverBelowBase(uint256 age) public view {
        age = bound(age, 0, 3650 days);
        assertGe(h.spreadLog(h0, age), h0);
    }

    function testFuzz_widenMonotone(uint256 a, uint256 b) public view {
        a = bound(a, 0, 2 hours);
        b = bound(b, a, 2 hours);
        assertLe(h.spreadLog(h0, a), h.spreadLog(h0, b));
    }

    function testFuzz_fadeMonotone(uint256 a, uint256 b) public view {
        a = bound(a, 2 hours, 3 hours);
        b = bound(b, a, 3 hours);
        assertGe(h.spreadLog(h0, a), h.spreadLog(h0, b));
    }

    function test_band() public pure {
        uint256 a = Q128; // $1
        (uint256 askF, uint256 bidC) = P.band(a, 1.01e18, true);
        assertEq(askF, (Q128 * 101) / 100 + (Q128 % 100 == 0 ? 0 : 1));
        assertLt(bidC, a);
        (askF, bidC) = P.band(a, 1.01e18, false);
        assertEq(askF, 0);
        assertEq(bidC, 0);
    }

    function testFuzz_recentrePutsMidAtAnchor(uint256 u, uint256 v) public view {
        u = bound(u, 1e9, 1e30);
        v = bound(v, 1e9, 1e30);
        uint256 t = h.recentre(u, v);
        // mid / anchor = (v/u) / T should be 1 to within rounding
        uint256 back = (t * u) / Q128;
        assertApproxEqRel(back, v, 1e9);
    }

    function test_recentreRejectsEmpty() public {
        vm.expectRevert(P.BadParams.selector);
        h.recentre(0, 1);
        vm.expectRevert(P.BadParams.selector);
        h.recentre(1, 0);
    }

    function test_recoveryGate() public pure {
        uint256 last = 1000;
        uint256 local = last + 2 hours;
        uint256 nowTs = local + 5 hours;
        assertTrue(P.recoveryOk(nowTs - 30, last, nowTs), "recent, after entry");
        assertTrue(P.recoveryOk(nowTs - 120, last, nowTs), "at the limit");
        assertFalse(P.recoveryOk(nowTs - 121, last, nowTs), "too old on arrival");
        assertFalse(P.recoveryOk(local - 1, last, local + 60), "taken before local mode began");
        assertFalse(P.recoveryOk(last, last, nowTs), "not newer");
        assertFalse(P.recoveryOk(nowTs + 1, last, nowTs), "from the future");
        assertTrue(P.updateOk(last + 1, last, nowTs));
        assertFalse(P.updateOk(last, last, nowTs));
        assertFalse(P.updateOk(nowTs + 1, last, nowTs));
    }

    function test_refund() public pure {
        uint256 fee = 5e13;
        uint256 a = Q128;
        assertEq(P.refund(a, (a * 1011) / 1000, 10 minutes, fee), 6e13, "1.1% move: fee + 20%");
        assertEq(P.refund(a, (a * 99) / 100, 10 minutes, fee), 6e13, "1% down");
        assertEq(P.refund(a, (a * 1005) / 1000, 10 minutes, fee), 0, "0.5% move, not a heartbeat: unpaid");
        assertEq(P.refund(a, a, 59 minutes, fee), 6e13, "heartbeat");
        assertEq(P.refund(a, a, 59 minutes - 1, fee), 0, "early heartbeat unpaid");
    }

    function test_refreshDue() public pure {
        uint256 a = Q128;
        assertTrue(P.refreshDue(a, (a * 1011) / 1000, 0));
        assertFalse(P.refreshDue(a, (a * 1009) / 1000, 59 minutes));
        assertTrue(P.refreshDue(a, a, 3570));
    }
}

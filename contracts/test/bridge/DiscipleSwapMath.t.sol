// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiscipleSwapMath as M} from "../../src/bridge/libraries/DiscipleSwapMath.sol";
import {DiscipleSwapMathVectors as V} from "./DiscipleSwapMathVectors.sol";
import {DiscipleSwapMathGptVectors as GV} from "./DiscipleSwapMathGptVectors.sol";

/// @dev External wrappers so reverts and gas can be measured per call.
contract SwapMathHarness {
    function buyExactIn(uint256 u, uint256 v, uint256 k, uint256 p, uint256 a) external pure returns (uint256) {
        return M.buyExactIn(u, v, k, p, a);
    }

    function buyExactOut(uint256 u, uint256 v, uint256 k, uint256 p, uint256 a) external pure returns (uint256) {
        return M.buyExactOut(u, v, k, p, a);
    }

    function sellExactIn(uint256 u, uint256 v, uint256 k, uint256 p, uint256 a) external pure returns (uint256) {
        return M.sellExactIn(u, v, k, p, a);
    }

    function sellExactOut(uint256 u, uint256 v, uint256 k, uint256 p, uint256 a) external pure returns (uint256) {
        return M.sellExactOut(u, v, k, p, a);
    }

    function fill(uint8 fn, uint256 u, uint256 v, uint256 k, uint256 p, uint256 a) external pure returns (uint256) {
        if (fn == 0) return M.buyExactIn(u, v, k, p, a);
        if (fn == 1) return M.buyExactOut(u, v, k, p, a);
        if (fn == 2) return M.sellExactIn(u, v, k, p, a);
        return M.sellExactOut(u, v, k, p, a);
    }

    function premium(uint256 h0, uint256 tau, uint256 e) external pure returns (uint256) {
        return M.premium(h0, tau, e);
    }

    function markup(uint256 h, uint256 fee) external pure returns (uint256) {
        return M.markup(h, fee);
    }

    function slopes(uint256 pRef, uint256 t, uint256 g) external pure returns (uint256, uint256) {
        return M.slopes(pRef, t, g);
    }
}

contract DiscipleSwapMathTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q128 = 1 << 128;

    SwapMathHarness internal h;

    function setUp() public {
        h = new SwapMathHarness();
    }

    // ---- vectors from the Python mirror and the 80-digit reference ------------------------------

    function test_fillVectors() public view {
        V.Fill[] memory f = V.fills();
        for (uint256 i = 0; i < f.length; i++) {
            V.Fill memory c = f[i];
            uint256 got = h.fill(c.fn, c.u, c.v, c.k, c.p, c.amount);
            assertEq(got, c.expected, string.concat("vector ", vm.toString(i), " differs from the Python mirror"));
            if (c.fn == 0 || c.fn == 2) {
                assertLe(got, c.exactBound, string.concat("vector ", vm.toString(i), " pays out more than exact"));
            } else {
                assertGe(got, c.exactBound, string.concat("vector ", vm.toString(i), " charges less than exact"));
            }
        }
    }

    /// GPT's 20 independently computed trades. Never above GPT's ideal output (beyond its 18-digit precision), and
    /// within 1e-12 of it, or 1e-6 on the two dust trades (1e-6 quote into a 500/500 pool).
    function test_gptVectors() public view {
        GV.Gpt[] memory g = GV.all();
        for (uint256 i = 0; i < g.length; i++) {
            GV.Gpt memory c = g[i];
            (uint256 kb, uint256 ks) = h.slopes(c.pRef, c.t, c.g);
            (uint256 pa, uint256 pb) = M.matchBounds(c.srcAsk, c.srcBid, 1);
            uint256 got = c.fn == 0 ? h.buyExactIn(c.u, c.v, kb, pa, c.amount) : h.sellExactIn(c.u, c.v, ks, pb, c.amount);
            string memory id = string.concat("GPT vector T", vm.toString(i + 1));
            assertLe(got, c.ideal + c.ideal / 1e16 + 1, string.concat(id, " pays more than ideal"));
            uint256 tol = c.ideal < 1e15 ? c.ideal / 1e6 : c.ideal / 1e12;
            assertGe(got + tol, c.ideal, string.concat(id, " too far below ideal"));
        }
    }

    function test_premiumVectors() public view {
        V.Prem[] memory r = V.premiums();
        for (uint256 i = 0; i < r.length; i++) {
            assertEq(h.premium(r[i].h0, r[i].tau, r[i].elapsed), r[i].expected);
        }
    }

    function test_markupVectors() public view {
        V.Mark[] memory r = V.markups();
        for (uint256 i = 0; i < r.length; i++) {
            assertEq(h.markup(r[i].h, r[i].fee), r[i].expected);
        }
    }

    // ---- pricing inputs ----------------------------------------------------------------------------

    function test_premiumShape() public view {
        uint256 h0 = 4e16;
        assertEq(h.premium(0, 30, 0), WAD, "off");
        assertGe(h.premium(h0, 30, 0), WAD + h0, "fresh: full 4%");
        assertLe(h.premium(h0, 30, 0), WAD + h0 + 1);
        // after one tau: 4% / e = 1.4715...%
        assertApproxEqAbs(h.premium(h0, 30, 30), WAD + 14715177646857694, 1e3);
        assertEq(h.premium(h0, 30, 1 days), WAD + 1, "decayed: within a wei of 1x");
        assertGe(h.premium(h0, 30, 10), h.premium(h0, 30, 11), "never rises with time");
    }

    function test_markupIsInputFee() public {
        // G = 1 / (1 - 0.3%) so a buyer's quote, after the fee comes off the input, prices at the curve.
        assertEq(h.markup(WAD, 3000), Math.mulDiv(WAD, 1e6, 997_000, Math.Rounding.Ceil));
        vm.expectRevert(M.BadParams.selector);
        h.markup(WAD, 1e6);
    }

    function test_slopesRoundTowardPool() public view {
        uint256 t = Q128 / 3;
        (uint256 kb, uint256 ks) = h.slopes(t, t, h.markup(WAD, 3000));
        assertGt(kb, WAD, "ask above mid");
        assertLt(ks, WAD, "bid below mid");
        // kb * ks <= 1 / (1-f)^2 * (1-f)^2 = 1: the round trip spread never closes
        assertLe(Math.mulDiv(kb, ks, WAD), WAD);
    }

    function test_matchBoundsAndReset() public pure {
        (uint256 a, uint256 b) = M.matchBounds(1e6 * Q128, 1e6 * Q128, 1);
        assertEq(a, 999_900 * Q128, "ask floor 1bp inside");
        assertEq(b, 1_000_100 * Q128, "bid ceiling 1bp inside");
        assertTrue(M.movedBeyond(0, 1, 25), "no reference yet: reset");
        assertFalse(M.movedBeyond(10_000, 10_024, 25));
        assertTrue(M.movedBeyond(10_000, 10_025, 25));
        assertTrue(M.movedBeyond(10_000, 9_975, 25));
    }

    // ---- boundary behaviour ------------------------------------------------------------------------

    /// A pool at 1:1 with the source's ask 1% above the curve's ask: small buys fill on the straight line at the
    /// source price exactly, big buys cross onto the curve and pay at least the line price on every unit.
    function test_boundaryLineThenCurve() public view {
        (uint256 u, uint256 v, uint256 kb,) = _pool(1e24, 1e24);
        uint256 askCurve = Math.mulDiv(kb, Q128, WAD); // r = 1
        uint256 p = askCurve * 101 / 100;
        (uint256 ub, uint256 vb) = M.boundPoint(u, v, kb, p);
        assertGt(vb, v, "floor binds");
        uint256 small = (vb - v) / 2;
        assertEq(h.buyExactIn(u, v, kb, p, small), Math.mulDiv(small, Q128, p), "line: exactly the floor price");
        uint256 big = (vb - v) * 4;
        uint256 out = h.buyExactIn(u, v, kb, p, big);
        assertLt(out, Math.mulDiv(big, Q128, p), "past the crossing the curve is dearer than the line");
        assertGt(out, u - ub, "and still gets the whole line segment plus some curve");
    }

    function test_boundaryOffIsPureCurve() public view {
        (uint256 u, uint256 v, uint256 kb,) = _pool(1e24, 1e24);
        uint256 p = Math.mulDiv(kb, Q128, WAD) * 99 / 100; // floor below the curve: never binds
        assertEq(h.buyExactIn(u, v, kb, p, 1e21), h.buyExactIn(u, v, kb, 0, 1e21));
    }

    // ---- properties at frozen external state -----------------------------------------------------

    function testFuzz_buySplitNeverBeatsWhole(uint256 seed, uint256 q, uint256 a) public view {
        (uint256 u, uint256 v, uint256 kb, uint256 pa,,) = _state(seed);
        q = bound(q, 2, v * 2);
        a = bound(a, 1, q - 1);
        uint256 whole = h.buyExactIn(u, v, kb, pa, q);
        uint256 o1 = h.buyExactIn(u, v, kb, pa, a);
        uint256 o2 = h.buyExactIn(u - o1, v + a, kb, pa, q - a);
        assertLe(o1 + o2, whole);
    }

    function testFuzz_sellSplitNeverBeatsWhole(uint256 seed, uint256 q, uint256 a) public view {
        (uint256 u, uint256 v,, uint256 ks,, uint256 pb) = _state(seed);
        q = bound(q, 2, u * 2);
        a = bound(a, 1, q - 1);
        uint256 whole = h.sellExactIn(u, v, ks, pb, q);
        uint256 o1 = h.sellExactIn(u, v, ks, pb, a);
        uint256 o2 = h.sellExactIn(u + a, v - o1, ks, pb, q - a);
        assertLe(o1 + o2, whole);
    }

    function testFuzz_exactOutSplitNeverCheaper(uint256 seed, uint256 q, uint256 a) public view {
        (uint256 u, uint256 v, uint256 kb, uint256 pa,,) = _state(seed);
        q = bound(q, 2, u / 2);
        a = bound(a, 1, q - 1);
        uint256 whole = h.buyExactOut(u, v, kb, pa, q);
        uint256 c1 = h.buyExactOut(u, v, kb, pa, a);
        uint256 c2 = h.buyExactOut(u - a, v + c1, kb, pa, q - a);
        assertGe(c1 + c2, whole);
    }

    function testFuzz_roundTripNeverProfits(uint256 seed, uint256 q) public view {
        (uint256 u, uint256 v, uint256 kb, uint256 pa, uint256 ks, uint256 pb) = _state(seed);
        q = bound(q, 1, v * 2);
        uint256 coins = h.buyExactIn(u, v, kb, pa, q);
        uint256 back = h.sellExactIn(u - coins, v + q, ks, pb, coins);
        assertLe(back, q);
    }

    function testFuzz_monotonicAndSolvent(uint256 seed, uint256 q) public view {
        (uint256 u, uint256 v, uint256 kb, uint256 pa, uint256 ks, uint256 pb) = _state(seed);
        q = bound(q, 1, v * 4);
        uint256 o = h.buyExactIn(u, v, kb, pa, q);
        assertLt(o, u, "never empties the coin reserve");
        assertGe(h.buyExactIn(u, v, kb, pa, q + 1), o, "more in, not less out");
        uint256 s = h.sellExactIn(u, v, ks, pb, q);
        assertLt(s, v, "never empties the quote reserve");
        assertGe(h.sellExactIn(u, v, ks, pb, q + 1), s);
    }

    function testFuzz_exactOutCoversExactIn(uint256 seed, uint256 q) public view {
        (uint256 u, uint256 v, uint256 kb, uint256 pa,,) = _state(seed);
        q = bound(q, 1, u / 2);
        uint256 cost = h.buyExactOut(u, v, kb, pa, q);
        // Paying the exact-out quote through exact-in returns q coins, less both quotes' pool-side slack. The slack
        // is bounded by a few wei plus ~1e-15 of the reserve (not of the trade), so on dust trades it can be a large
        // share of q; the bound below is the real guarantee: ~1e-13 of the coin reserve.
        uint256 got = h.buyExactIn(u, v, kb, pa, cost);
        assertGe(got + 2 + u / 1e13, q);
    }

    // ---- reverts ---------------------------------------------------------------------------------

    function test_cannotTakeWholeReserve() public {
        (uint256 u, uint256 v, uint256 kb, uint256 ks) = _pool(1e24, 1e24);
        vm.expectRevert(M.InsufficientReserve.selector);
        h.buyExactOut(u, v, kb, 0, u);
        vm.expectRevert(M.InsufficientReserve.selector);
        h.sellExactOut(u, v, ks, 0, v);
    }

    function test_absurdExactOutReverts() public {
        uint256 u = 1e24;
        uint256 t = Q128;
        // Anchor 3x the seed ratio: buying all but 1 wei would need (1e24)^3 times the quote reserve.
        (uint256 kb,) = h.slopes(3 * t, t, h.markup(WAD, 3000));
        uint256 v = 1e24;
        vm.expectRevert(M.TradeTooLarge.selector);
        h.buyExactOut(u, v, kb, 0, u - 1);
    }

    // ---- gas -------------------------------------------------------------------------------------

    function test_gas() public view {
        (uint256 u, uint256 v, uint256 kb, uint256 ks) = _pool(2_500e18 * 1000, 2_500e6); // $2.5k a side, $0.001 coin
        uint256 r = Math.mulDiv(v, Q128, u);
        uint256 pa = Math.mulDiv(Math.mulDiv(kb, r, WAD), 1_010_000, 1e6);
        uint256 pb = Math.mulDiv(Math.mulDiv(ks, r, WAD), 990_000, 1e6);
        uint256 g;
        uint256 worst;
        for (uint256 i = 0; i < 6; i++) {
            g = gasleft();
            if (i == 0) h.buyExactIn(u, v, kb, 0, 100e6);
            if (i == 1) h.buyExactIn(u, v, kb, pa, 500e6);
            if (i == 2) h.buyExactOut(u, v, kb, 0, 50_000e18);
            if (i == 3) h.sellExactIn(u, v, ks, 0, 100_000e18);
            if (i == 4) h.sellExactIn(u, v, ks, pb, 500_000e18);
            if (i == 5) h.sellExactOut(u, v, ks, pb, 50e6);
            g -= gasleft();
            // 0 buy in, 1 buy in crossing, 2 buy out, 3 sell in, 4 sell in crossing, 5 sell out
            console2.log("fill type, gas", i, g);
            if (g > worst) worst = g;
        }
        assertLt(worst, 40_000, "a fill (incl. external call overhead) stays well under 40k gas");
    }

    // ---- helpers -----------------------------------------------------------------------------------

    function _pool(uint256 u, uint256 v) internal view returns (uint256, uint256, uint256 kb, uint256 ks) {
        uint256 t = Math.mulDiv(v, Q128, u);
        (kb, ks) = h.slopes(t, t, h.markup(WAD, 3000));
        return (u, v, kb, ks);
    }

    /// Realistic random state: reserves 1e12..1e27 wei, anchor within ~3x of the seed ratio, 0.3% fee, a premium
    /// somewhere in its decay, and a match boundary that binds about half the time.
    function _state(uint256 seed)
        internal
        view
        returns (uint256 u, uint256 v, uint256 kb, uint256 pa, uint256 ks, uint256 pb)
    {
        u = 1e12 + uint256(keccak256(abi.encode(seed, 1))) % 1e27;
        v = 1e12 + uint256(keccak256(abi.encode(seed, 2))) % 1e27;
        uint256 t = Math.mulDiv(v, Q128, u);
        uint256 pRef = Math.mulDiv(t, 333 + uint256(keccak256(abi.encode(seed, 3))) % 2700, 1000);
        uint256 g = h.markup(h.premium(4e16, 30, uint256(keccak256(abi.encode(seed, 4))) % 300), 3000);
        (kb, ks) = h.slopes(pRef, t, g);
        uint256 r = Math.mulDiv(v, Q128, u);
        uint256 e = uint256(keccak256(abi.encode(seed, 5)));
        if (e % 3 != 0) {
            pa = Math.mulDiv(Math.mulDiv(kb, r, WAD), 995_000 + (e >> 8) % 35_000, 1e6);
            pb = Math.mulDiv(Math.mulDiv(ks, r, WAD), 1_005_000 - (e >> 40) % 35_000, 1e6);
        }
    }
}

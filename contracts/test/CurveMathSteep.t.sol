// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev External wrapper so vm.expectRevert / gas work on library calls.
contract CurveHarness {
    function buyQ(uint256 price, uint256 s, uint256 t) external pure returns (uint256) {
        return CurveMath.quoteInForTokens(CurveMath.makeParams(price), s, t);
    }

    function out(uint256 price, uint256 s, uint256 q) external pure returns (uint256) {
        return CurveMath.tokensOutForQuote(CurveMath.makeParams(price), s, q);
    }
}

/// @notice Steep curve #1: m(g) = 3333/(1 − a·g)² + T·g^30 → $33,333 at 84.24% sold.
contract CurveMathSteepTest is Test {
    uint256 constant USD18 = 1e18; // USDG 18-dec: $1 per 1e18 raw
    uint256 constant USD6 = 1e30; // USDG 6-dec: $1 per 1e6 raw → 1e30 USD-WAD per 1e18 raw
    uint256 constant RAY = 1e36;

    CurveHarness h = new CurveHarness();

    function _p(bool six) internal pure returns (CurveMath.Params memory) {
        return CurveMath.makeParams(six ? USD6 : USD18);
    }

    /// Reference cost with no shared code path: float-free closed form in 1e36 fixed point, exact enough (<1 wei).
    function _ref(CurveMath.Params memory p, uint256 s1, uint256 s2) internal pure returns (uint256 lo, uint256 hi) {
        // CP part: x0·y0·dt / ((y0−s1)(y0−s2)) exactly floor/ceil
        uint256 num = p.x0 * p.y0;
        uint256 cpLo = Math.mulDiv(num, s2 - s1, (p.y0 - s1) * (p.y0 - s2));
        uint256 cpHi = Math.mulDiv(num, s2 - s1, (p.y0 - s1) * (p.y0 - s2), Math.Rounding.Ceil);
        // tail: tail·sC/(31·S)·(g2^31 − g1^31), g^31 by naive repeated multiply (different order than lib)
        uint256 a = _naive31(s1, p.sCurve);
        uint256 b = _naive31(s2, p.sCurve);
        uint256 t = Math.mulDiv(p.tail * p.sCurve, b - a, 31 * p.totalSupply * RAY);
        lo = cpLo + t;
        hi = cpHi + t + 1;
    }

    function _naive31(uint256 s, uint256 sC) internal pure returns (uint256 r) {
        uint256 g = Math.mulDiv(s, RAY, sC);
        r = g;
        for (uint256 i = 1; i < 31; ++i) r = Math.mulDiv(r, g, RAY);
    }

    // ───────── shape ─────────

    function test_endpoints_18_and_6() public pure {
        for (uint256 k; k < 2; ++k) {
            bool six = k == 1;
            CurveMath.Params memory p = _p(six);
            uint256 unit = six ? uint256(1e6) : 1e18;
            assertEq(p.sCurve, 842_400e18, "sCurve 84.24%");
            assertApproxEqAbs(CurveMath.marketCapQuote(p, 0), 3_333 * unit, unit / 1e3, "start $3,333");
            assertEq(CurveMath.marketCapQuote(p, p.sCurve), 33_333 * unit, "end exactly $33,333");
            assertEq(CurveMath.marketCapUsd(p, p.sCurve), 33_333e18, "end usd");
            // CP part alone reaches ~$15K at g=1; tail ~= $18,333
            assertApproxEqRel(p.tail, 18_333 * unit, 1e14, "tail");
            // Raise: quote that reaches the curve over the whole run ≈ $6,455 (= $6,520 paid incl. the 1% fee);
            // the pool pairs 15.76% of supply at $33,333 ≈ $5,253 → leftover ≈ $1,201 for the floor.
            uint256 raise = CurveMath.quoteInForTokens(p, 0, p.sCurve);
            uint256 pairQ = Math.mulDiv(33_333 * unit, p.totalSupply - p.sCurve, p.totalSupply);
            if (!six) {
                console2.log("raise to curve (e18)", raise);
                console2.log("raise gross incl 1% fee (e18)", raise * 100 / 99);
                console2.log("pool pairing (e18)", pairQ);
                console2.log("leftover (e18)", raise - pairQ);
            }
            assertApproxEqAbs(raise * 100 / 99, 6_520 * unit, 5 * unit, "gross raise ~$6,520");
            assertApproxEqAbs(raise - pairQ, 1_201 * unit, 5 * unit, "leftover ~$1,201");
        }
    }

    function test_priceStrictlyIncreasing() public pure {
        CurveMath.Params memory p = _p(false);
        uint256 last;
        for (uint256 i; i <= 400; ++i) {
            uint256 s = (p.sCurve * i) / 400;
            uint256 m = CurveMath.marketCapQuote(p, s);
            if (i > 0) assertGt(m, last, "strictly increasing");
            last = m;
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_priceMonotone(bool six, uint256 aSeed, uint256 dSeed) public pure {
        CurveMath.Params memory p = _p(six);
        uint256 s = bound(aSeed, 0, p.sCurve - 1e15);
        uint256 d = bound(dSeed, 1e15, p.sCurve - s); // >= 0.001 token
        assertGt(CurveMath.marketCapQuote(p, s + d), CurveMath.marketCapQuote(p, s));
    }

    // ───────── cost ─────────

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_costWithin1WeiOfClosedForm(bool six, uint256 aSeed, uint256 bSeed) public pure {
        CurveMath.Params memory p = _p(six);
        uint256 s1 = bound(aSeed, 0, p.sCurve - 1);
        uint256 s2 = bound(bSeed, s1 + 1, p.sCurve);
        (uint256 lo, uint256 hi) = _ref(p, s1, s2);
        uint256 up = CurveMath.costUp(p, s1, s2);
        uint256 dn = CurveMath.costDown(p, s1, s2);
        assertLe(dn, up, "down <= up");
        assertGe(up + 1, lo, "up within 1 wei below ref");
        assertLe(up, hi + 1, "up within 1 wei above ref");
        assertGe(dn + 1, lo, "down within 1 wei below ref");
        assertLe(up - dn, 2, "up/down spread <= 2 wei");
    }

    /// forge-config: default.fuzz.runs = 500
    function testFuzz_costAdditive(bool six, uint256 aSeed, uint256 bSeed, uint256 cSeed) public pure {
        CurveMath.Params memory p = _p(six);
        uint256 s1 = bound(aSeed, 0, p.sCurve - 2);
        uint256 s3 = bound(cSeed, s1 + 2, p.sCurve);
        uint256 s2 = bound(bSeed, s1 + 1, s3 - 1);
        uint256 whole = CurveMath.costUp(p, s1, s3);
        uint256 parts = CurveMath.costUp(p, s1, s2) + CurveMath.costUp(p, s2, s3);
        assertGe(parts, whole, "splitting a buy never cheaper");
        assertLe(parts - whole, 3, "split rounding <= 3 wei");
    }

    // ───────── inverse rounding ─────────

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_inverseRoundsDown(bool six, uint256 sSeed, uint256 qSeed) public pure {
        CurveMath.Params memory p = _p(six);
        uint256 unit = six ? uint256(1e6) : 1e18;
        uint256 s = bound(sSeed, 0, p.sCurve - 1);
        uint256 q = bound(qSeed, 1, 10_000 * unit);
        uint256 dt = CurveMath.tokensOutForQuote(p, s, q);
        assertLe(s + dt, p.sCurve, "within curve");
        if (dt > 0) assertLe(CurveMath.costUp(p, s, s + dt), q, "never more tokens than paid for");
        // Near-maximal: Newton from above may stop short by at most ~3 quote wei worth of tokens (dust, in the
        // pool's favour); the exact maximum is not searched for to keep buys cheap.
        uint256 slack = (3 * 1e18) / CurveMath.spotPriceWad(p, s + dt) + 1;
        if (s + dt + slack <= p.sCurve) assertGt(CurveMath.costUp(p, s, s + dt + slack), q, "near-maximal");
    }

    /// forge-config: default.fuzz.runs = 500
    function testFuzz_inverseCapped(bool six, uint256 sSeed, uint256 qSeed, uint256 cSeed) public pure {
        CurveMath.Params memory p = _p(six);
        uint256 s = bound(sSeed, 0, p.sCurve - 1);
        uint256 q = bound(qSeed, 1, 10_000 * (six ? uint256(1e6) : 1e18));
        uint256 cap = bound(cSeed, 1, p.sCurve - s);
        uint256 full = CurveMath.tokensOutForQuote(p, s, q);
        uint256 got = CurveMath.tokensOutForQuoteCapped(p, s, q, cap);
        if (full >= cap) {
            assertEq(got, cap, "affordable cap is filled exactly");
        } else {
            assertLe(CurveMath.costUp(p, s, s + got), q, "never more than paid for");
            uint256 slack = (3 * 1e18) / CurveMath.spotPriceWad(p, s + got) + 1;
            assertApproxEqAbs(got, full, slack, "same result up to dust");
        }
    }

    // ───────── no free lunch ─────────

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_noProfitableBuyThenSell(bool six, uint256 sSeed, uint256 qSeed) public pure {
        CurveMath.Params memory p = _p(six);
        uint256 s = bound(sSeed, 0, p.sCurve - 1);
        uint256 q = bound(qSeed, 1, 10_000 * (six ? uint256(1e6) : 1e18));
        uint256 dt = CurveMath.tokensOutForQuote(p, s, q);
        uint256 back = CurveMath.quoteOutForTokens(p, s + dt, dt);
        assertLe(back, q, "buy->sell never profits");
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_noProfitableSellThenBuy(bool six, uint256 sSeed, uint256 tSeed) public pure {
        CurveMath.Params memory p = _p(six);
        uint256 s = bound(sSeed, 1, p.sCurve - 1);
        uint256 t = bound(tSeed, 1, s);
        uint256 q = CurveMath.quoteOutForTokens(p, s, t);
        assertLe(CurveMath.tokensOutForQuote(p, s - t, q), t, "sell->buy never gains tokens (G-7)");
    }

    // ───────── overflow / extremes ─────────

    /// forge-config: default.fuzz.runs = 300
    function testFuzz_noOverflowAcrossQuotePrices(uint256 priceSeed, uint256 sSeed) public pure {
        uint256 price = bound(priceSeed, 1e15, 1e33); // $0.001/18-dec … 6-dec stable … $1000/6-dec
        CurveMath.Params memory p = CurveMath.makeParams(price);
        uint256 s = bound(sSeed, 0, p.sCurve);
        CurveMath.marketCapQuote(p, s);
        CurveMath.spotPriceWad(p, s);
        uint256 full = CurveMath.quoteInForTokens(p, 0, p.sCurve);
        assertEq(CurveMath.tokensOutForQuote(p, 0, full), p.sCurve, "full curve inverse");
        if (s > 0) CurveMath.quoteOutForTokens(p, s, s);
        assertEq(CurveMath.marketCapQuote(p, p.sCurve), Math.mulDiv(Constants.GRADUATION_MCAP_USD, 1e18, price));
    }

    function test_reverts_pastCurve() public {
        vm.expectRevert(CurveMath.InsufficientLiquidity.selector);
        h.buyQ(USD18, 842_400e18, 1);
    }

    function test_inverse_wholeCurveAndOverpay() public pure {
        CurveMath.Params memory p = _p(false);
        uint256 c = CurveMath.quoteInForTokens(p, 0, p.sCurve);
        assertEq(CurveMath.tokensOutForQuote(p, 0, c), p.sCurve, "exact cost buys the whole curve");
        assertLt(CurveMath.tokensOutForQuote(p, 0, c - 1), p.sCurve, "one wei short does not");
        assertEq(CurveMath.tokensOutForQuote(p, 0, 1e30), p.sCurve, "overpay clamps to curve end");
    }

    // ───────── gas (library) ─────────

    function test_gas_libraryBuySell() public {
        uint256 s = 600_000e18; // deep in the steep tail region (g ≈ 0.71)
        uint256 g0 = gasleft();
        h.out(USD18, s, 500e18);
        uint256 gBuy = g0 - gasleft();
        g0 = gasleft();
        h.buyQ(USD18, s, 10_000e18);
        uint256 gQ = g0 - gasleft();
        console2.log("lib tokensOutForQuote($500) gas", gBuy);
        console2.log("lib quoteInForTokens gas", gQ);
    }
}

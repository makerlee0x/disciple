// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiscipleFlatMath as F} from "../../../src/hook/libraries/DiscipleFlatMath.sol";
import {FixedPointMathLib as FPM} from "../../../src/hook/libraries/vendor/FixedPointMathLib.sol";
import {DiscipleFlatMathVectors as V} from "./DiscipleFlatMathVectors.sol";

contract FlatHarness {
    function fill(uint8 fn, uint256 u, uint256 v, uint256 k, uint256 p, uint256 t, uint256 a)
        external
        pure
        returns (uint256)
    {
        if (fn == 0) return F.buyExactIn(u, v, k, p, t, a, F.DEFAULT_SHAPE);
        if (fn == 1) return F.buyExactOut(u, v, k, p, t, a, F.DEFAULT_SHAPE);
        if (fn == 2) return F.sellExactIn(u, v, k, p, t, a, F.DEFAULT_SHAPE);
        return F.sellExactOut(u, v, k, p, t, a, F.DEFAULT_SHAPE);
    }
}

contract FlatHarnessShaped {
    function fill(uint8 fn, uint256 u, uint256 v, uint256 k, uint256 p, uint256 t, uint256 a, uint256 sh)
        external
        pure
        returns (uint256)
    {
        if (fn == 0) return F.buyExactIn(u, v, k, p, t, a, sh);
        if (fn == 1) return F.buyExactOut(u, v, k, p, t, a, sh);
        if (fn == 2) return F.sellExactIn(u, v, k, p, t, a, sh);
        return F.sellExactOut(u, v, k, p, t, a, sh);
    }

    function shape(uint256 lam) external pure returns (uint256) {
        return F.shape(lam);
    }
}

contract DiscipleFlatMathTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q128 = 1 << 128;
    FlatHarness internal h;

    FlatHarnessShaped internal hs;

    function setUp() public {
        h = new FlatHarness();
        hs = new FlatHarnessShaped();
    }

    /// v0.3: the per-pool flatness anywhere in [MIN_LAM, MAX_LAM] (seeded, including both bounds).
    function _lam(uint256 seed) internal pure returns (uint256) {
        uint256 r = uint256(keccak256(abi.encode(seed, "lam"))) % 10;
        if (r == 0) return F.MIN_LAM;
        if (r == 1) return F.MAX_LAM;
        return F.MIN_LAM + uint256(keccak256(abi.encode(seed, "lam2"))) % (F.MAX_LAM - F.MIN_LAM);
    }

    function testFuzz_flat_anyLam_splitNeverBeatsWhole(uint256 seed) public view {
        uint256 sh = hs.shape(_lam(seed));
        (uint256 u, uint256 v, uint256 t, uint256 k, uint256 a) = _state(seed, true);
        uint256 whole = hs.fill(0, u, v, k, 0, t, a, sh);
        uint256 a1 = a / 3;
        uint256 o1 = hs.fill(0, u, v, k, 0, t, a1, sh);
        uint256 o2 = hs.fill(0, u - o1, v + a1, k, 0, t, a - a1, sh);
        assertLe(o1 + o2, whole + 1, "buy split");
        (u, v, t, k, a) = _state(seed ^ 1, false);
        whole = hs.fill(2, u, v, k, 0, t, a, sh);
        o1 = hs.fill(2, u, v, k, 0, t, a1 = a / 3, sh);
        o2 = hs.fill(2, u + a1, v - o1, k, 0, t, a - a1, sh);
        assertLe(o1 + o2, whole + 1, "sell split");
    }

    function testFuzz_flat_anyLam_roundTripLoses(uint256 seed) public view {
        uint256 sh = hs.shape(_lam(seed));
        (uint256 u, uint256 v, uint256 t,, uint256 a) = _state(seed, true);
        uint256 c = hs.fill(0, u, v, 1010101010101010102, 0, t, a, sh);
        if (c == 0) return;
        uint256 back = hs.fill(2, u - c, v + a, 990000000000000000, 0, t, c, sh);
        assertLe(back, a, "buy then sell never profits");
    }

    function testFuzz_flat_anyLam_exactOutCoversExactIn(uint256 seed) public view {
        uint256 sh = hs.shape(_lam(seed));
        (uint256 u, uint256 v, uint256 t, uint256 k, uint256 a) = _state(seed, true);
        // Both directions round for the pool with a margin sized on the RESERVE (1e-12 per pow), so exact-out may
        // charge slightly less than the exact-in input that produced `out` (exact-in already paid out less than the
        // true amount). Tolerance: 1e-9 of the trade plus 1e-11 of the reserve, as in test_flat_vectorsMatchSim
        // (v0.3 audit I-01 / L-2: the old trade-only bound failed at lam ~0.25 on a 1e-4-of-reserve trade).
        // Each direction is checked against the exact curve in test_flat_vectorsMatchSim; round trips and splits
        // never profit (the other anyLam fuzz tests).
        uint256 out = hs.fill(0, u, v, k, 0, t, a, sh);
        if (out > 1e6) {
            uint256 inQ = hs.fill(1, u, v, k, 0, t, out, sh);
            assertGe(inQ, a - a / 1e9 - v / 1e11, "buy");
        }
        (u, v, t, k, a) = _state(seed ^ 7, false);
        out = hs.fill(2, u, v, k, 0, t, a, sh);
        if (out > 1e6) {
            uint256 inC = hs.fill(3, u, v, k, 0, t, out, sh);
            assertGe(inC, a - a / 1e9 - u / 1e11, "sell");
        }
    }

    /// v0.3 audit (I-01 / L-2) counterexample at lam ~0.248: exact-out must still cover exact-in.
    function test_flat_auditCounterexampleExactOutCovers() public view {
        testFuzz_flat_anyLam_exactOutCoversExactIn(4122963194318678682658782080789381120);
    }

    /// With a match boundary set (the live-leader bound), at any flatness: a buy never pays below p.
    function testFuzz_flat_anyLam_boundaryHolds(uint256 seed) public view {
        uint256 sh = hs.shape(_lam(seed));
        (uint256 u, uint256 v, uint256 t, uint256 k, uint256 a) = _state(seed, true);
        uint256 p = Math.mulDiv(v, Q128, u) * (1000 + (seed % 50)) / 1000; // 0-5% above the spot ratio
        uint256 out = hs.fill(0, u, v, k, p, t, a, sh);
        if (out == 0) return;
        assertGe(Math.mulDiv(a, Q128, out), p - p / 1e12, "average buy price at or above the boundary");
    }

    /// @dev Matches the float sim within 1e-9 of the fill plus 1e-11 of the reserve (the pow margins are relative to
    ///      reserves), and any larger miss is on the pool's side.
    function test_flat_vectorsMatchSim() public view {
        uint256 worst;
        for (uint256 i; i < V.n(); i++) {
            V.V memory x = V.get(i);
            uint256 got = h.fill(x.fn, x.u, x.v, x.k, x.p, x.t, x.a);
            uint256 d = got > x.exp ? got - x.exp : x.exp - got;
            uint256 rel = d * 1e18 / x.exp;
            if (rel > worst) worst = rel;
            uint256 res = x.fn == 0 || x.fn == 3 ? x.u : x.v; // the reserve the result comes from / goes to
            uint256 tol = x.exp / 1e9 + res / 1e11 + 10;
            if (d > tol) {
                console2.log("vector", i, x.fn);
                console2.log("got / exp", got, x.exp);
            }
            assertLe(d, tol, "close to the sim");
            // exact-in pays out no more than the sim; exact-out asks no less, beyond the sim's float noise (it
            // differences reserves, so tiny fills carry ~1e-16 of the reserve; vector 81 is a pure line fill where
            // the contract is exact and the sim is 2e-9 low)
            uint256 noise = res / 1e12 + 10;
            if (x.fn == 0 || x.fn == 2) assertLe(got, x.exp + noise + x.exp / 1e10, "exact in: pool side");
            else assertGe(got + noise + x.exp / 1e10, x.exp, "exact out: pool side");
        }
        console2.log("worst relative diff (1e-18)", worst);
    }

    /// v0.3: the per-pool shape at the v0.2 flatness is exactly the v0.2 constants, so default fills are unchanged.
    function test_flat_defaultShapeIsV02() public pure {
        assertEq(F.shape(F.LAM), F.DEFAULT_SHAPE);
    }

    function test_flat_expConstants() public pure {
        assertEq(F.EW, uint256(FPM.expWad(int256(F.W))));
        assertEq(F.EWB, uint256(FPM.expWad(int256(F.W * F.BETA / WAD))));
    }

    // a balanced $100/$100 pool, price 1, 1% fee
    uint256 constant U = 100e18;
    uint256 constant VV = 100e18;
    uint256 constant KB = 1010101010101010102; // 1/(1-1%)
    uint256 constant KS = 990000000000000000;

    function test_flat_smallTradesNearCentre() public view {
        // $1 buy pays ~1% fee and almost no impact (v0.1 curve: ~3%)
        uint256 out = h.fill(0, U, VV, KB, 0, Q128, 1e18);
        uint256 avg = 1e18 * WAD / out; // quote per coin, WAD
        assertGt(avg, 1.0101e18);
        assertLt(avg, 1.0115e18, "$1 buy within 0.15% of fee-only");
        out = h.fill(0, U, VV, KB, 0, Q128, 20e18);
        avg = 20e18 * WAD / out;
        assertLt(avg, 1.03e18, "$20 buy on a $200 pool under +3%");
        uint256 got = h.fill(2, U, VV, KS, 0, Q128, 1e18);
        assertGt(got, 0.9885e18, "$1 sell near fee-only");
    }

    function testFuzz_flat_splitNeverBeatsWhole(uint256 seed) public view {
        (uint256 u, uint256 v, uint256 t, uint256 k, uint256 a) = _state(seed, true);
        uint256 whole = h.fill(0, u, v, k, 0, t, a);
        uint256 a1 = a / 3;
        uint256 o1 = h.fill(0, u, v, k, 0, t, a1);
        uint256 o2 = h.fill(0, u - o1, v + a1, k, 0, t, a - a1);
        assertLe(o1 + o2, whole + 1, "buy split");
        // sells
        (u, v, t, k, a) = _state(seed ^ 1, false);
        whole = h.fill(2, u, v, k, 0, t, a);
        o1 = h.fill(2, u, v, k, 0, t, a1 = a / 3);
        o2 = h.fill(2, u + a1, v - o1, k, 0, t, a - a1);
        assertLe(o1 + o2, whole + 1, "sell split");
    }

    function testFuzz_flat_exactOutCoversExactIn(uint256 seed) public view {
        (uint256 u, uint256 v, uint256 t, uint256 k, uint256 a) = _state(seed, true);
        uint256 out = h.fill(0, u, v, k, 0, t, a);
        if (out > 1e6) assertGe(h.fill(1, u, v, k, 0, t, out), a - a / 1e9, "buy: same coin costs about the same");
        if (out > 1e6) assertLe(h.fill(1, u, v, k, 0, t, out), a + a / 1e9 + 1);
        (u, v, t, k, a) = _state(seed ^ 7, false);
        out = h.fill(2, u, v, k, 0, t, a);
        if (out > 1e6) assertGe(h.fill(3, u, v, k, 0, t, out), a - a / 1e9, "sell: same quote needs about the same");
    }

    function testFuzz_flat_roundTripLoses(uint256 seed) public view {
        (uint256 u, uint256 v, uint256 t,, uint256 a) = _state(seed, true);
        uint256 kb = 1010101010101010102;
        uint256 ks = 990000000000000000;
        uint256 c = h.fill(0, u, v, kb, 0, t, a);
        if (c == 0) return;
        uint256 back = h.fill(2, u - c, v + a, ks, 0, t, c);
        assertLe(back, a, "buy then sell never profits");
    }

    /// @dev audit v0.2 H-1: v*WAD/u floored to 0 on a pool priced below 1e-18 quote raw per coin raw (e.g. an
    ///      18-decimal coin under $1e-6 in a 6-decimal quote), which made every band sell revert and buys pay 0.
    function test_flat_lowPricePoolTrades() public view {
        uint256 u = 1.005e24;
        uint256 v = 995_052;
        uint256 t = Q128 / 1e18;
        uint256 got = h.fill(2, u, v, 0.99e18, 0, t, 1e21);
        assertGt(got, 0, "band sell pays");
        uint256 out = h.fill(0, u, v, 1010101010101010102, 0, t, 100_000);
        // ~ quote / price / 1.0101, price ~ v/u
        uint256 fair = 100_000 * u / v;
        assertGt(out, fair * 97 / 100, "band buy pays about fair less fee");
        assertLt(out, fair, "and never more than fair");
    }

    /// @dev Low prices (ratio 1e-24 .. 1e-12 raw): fills never revert inside the band, round trips lose, splits
    ///      do not beat the whole by more than rounding.
    function testFuzz_flat_lowPrice(uint256 seed) public view {
        uint256 s = uint256(keccak256(abi.encode(seed, "low")));
        uint256 u = 1e24 + (s % 1e30);
        uint256 ratioE = 12 + ((s >> 64) % 13); // price 1e-12 .. 1e-24
        uint256 t = Q128 / (10 ** ratioE) + 1;
        uint256 lean = 500 + ((s >> 96) % 1500); // /1000, inside the band
        uint256 v = Math.mulDiv(u, t, Q128) * lean / 1000 + 1;
        if (v < 1e3) return; // a quote side of a few raw units cannot price anything
        uint256 a = v * (1 + ((s >> 128) % 2000)) / 10_000 + 1;
        uint256 c = h.fill(0, u, v, KB, 0, t, a);
        if (c == 0) return;
        uint256 back = h.fill(2, u - c, v + a, KS, 0, t, c);
        assertLe(back, a, "round trip loses");
        uint256 a1 = a / 3;
        uint256 o1 = h.fill(0, u, v, KB, 0, t, a1);
        uint256 o2 = h.fill(0, u - o1, v + a1, KB, 0, t, a - a1);
        assertLe(o1 + o2, c + c / 1e6 + 1, "split ~ whole");
    }

    function _state(uint256 seed, bool buy)
        internal
        pure
        returns (uint256 u, uint256 v, uint256 t, uint256 k, uint256 a)
    {
        uint256 s = uint256(keccak256(abi.encode(seed)));
        u = 1e15 + (s % 1e24);
        t = Q128 / 1000 + ((s >> 80) % (1000 * Q128));
        // lean between about e^-1 and e^1 around the seed ratio
        uint256 lean = 370 + ((s >> 160) % 2350); // /1000
        v = (u * (t / 1e9) / (Q128 / 1e9)) * lean / 1000 + 1e6;
        k = 0.97e18 + ((s >> 200) % 0.08e18);
        uint256 f = 1 + ((s >> 220) % 4000); // 1e-6 .. 0.4 of the side
        a = (buy ? v : u) * f / 10_000;
        if (a == 0) a = 1e6;
    }
}

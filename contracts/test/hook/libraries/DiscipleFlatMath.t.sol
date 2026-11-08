// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {DiscipleFlatMath as F} from "../../../src/hook/libraries/DiscipleFlatMath.sol";
import {DiscipleFlatMathVectors as V} from "./DiscipleFlatMathVectors.sol";

contract FlatHarness {
    function fill(uint8 fn, uint256 u, uint256 v, uint256 k, uint256 p, uint256 t, uint256 a)
        external
        pure
        returns (uint256)
    {
        if (fn == 0) return F.buyExactIn(u, v, k, p, t, a);
        if (fn == 1) return F.buyExactOut(u, v, k, p, t, a);
        if (fn == 2) return F.sellExactIn(u, v, k, p, t, a);
        return F.sellExactOut(u, v, k, p, t, a);
    }
}

contract DiscipleFlatMathTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q128 = 1 << 128;
    FlatHarness internal h;

    function setUp() public {
        h = new FlatHarness();
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

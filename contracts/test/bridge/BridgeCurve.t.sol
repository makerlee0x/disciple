// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";

contract BridgeCurveTest is Test {
    uint256 internal constant SEED = 77e18;
    uint256 internal constant ANCHOR = 1e18;

    function _fresh() internal pure returns (BridgeCurve.S memory s) {
        BridgeCurve.init(s, SEED, 0.33e18);
        BridgeCurve.onAnchor(s, ANCHOR);
    }

    function _ctx() internal pure returns (BridgeCurve.Ctx memory c) {
        c.gradTvl = 87_000e18;
        c.floorBps = 2_000;
        c.maxUsdgOut = type(uint256).max;
        c.boostWad = C.BOOST_START_WAD;
        c.tipRoom = 0;
    }

    function test_launchPriceIsThirtyThreePercentBelow() public pure {
        BridgeCurve.S memory s = _fresh();
        assertEq(s.y, 0, "no USDG required");
        assertEq(s.vx, 0, "launch book has no virtual coin");
        assertEq(BridgeCurve.spot(s), 0.67e18);
        assertEq(s.seedFloor, SEED / 2);
    }

    function test_climbsToAnchorBeforeHalfTheSeed() public pure {
        BridgeCurve.S memory s = _fresh();
        BridgeCurve.Ctx memory c = _ctx();
        uint256 x0 = s.x;
        uint256 i;
        while (BridgeCurve.spot(s) < s.anchor && i < 80) {
            (s,) = BridgeCurve.buyExactIn(s, 1e18, c);
            unchecked {
                ++i;
            }
        }
        assertGe(BridgeCurve.spot(s), s.anchor);
        uint256 soldBps = ((x0 - s.x) * 10_000) / x0;
        // 1 - sqrt(0.67) ≈ 18.2%. The 50% seed floor must not bind on this path.
        assertGt(soldBps, 1_500);
        assertLt(soldBps, 2_500);
        assertGt(s.x, s.seedFloor);
    }

    function test_seedFloorCapsDeepBookBelowAnchor() public pure {
        BridgeCurve.S memory s = _fresh();
        // A book this deep cannot reach the anchor before the seed floor.
        s.vx = s.x * 100;
        s.vy = Math.mulDiv(0.67e18, s.x + s.vx, C.WAD) - s.y;
        assertLt(BridgeCurve.spot(s), s.anchor);
        uint256 cap = BridgeCurve.maxCoinOut(s);
        assertEq(cap, s.x - s.seedFloor);
        BridgeCurve.Ctx memory c = _ctx();
        (s,) = BridgeCurve.buyExactIn(s, 10_000e18, c);
        assertGe(s.x, s.seedFloor);
    }

    function test_lastHalfSellsOnlyAtOrAboveAnchor() public pure {
        BridgeCurve.S memory s = _fresh();
        BridgeCurve.Ctx memory c = _ctx();
        // Walk through the anchor, then keep buying until the seed floor is behind us.
        uint256 i;
        while (s.x > s.seedFloor && i < 200) {
            BridgeCurve.S memory next;
            BridgeCurve.Fill memory f;
            (next, f) = BridgeCurve.buyExactIn(s, 2e18, c);
            if (f.coinOut == 0) break;
            if (next.x < s.seedFloor) {
                assertGe(BridgeCurve.spot(s), s.anchor, "crossed the floor while still discounted");
            }
            s = next;
            unchecked {
                ++i;
            }
        }
        assertLt(s.x, s.seedFloor);
        assertGe(BridgeCurve.spot(s), s.anchor);
    }

    function test_bandIsWideWhenTinyAndTightOnlyAtGraduation() public pure {
        uint256 grad = 86_520e18; // 12% of a ~$721k reference pool
        assertEq(BridgeCurve.bandWad(0, grad), C.BAND_START_WAD);
        assertEq(BridgeCurve.bandWad(C.BAND_TINY_TVL, grad), C.BAND_START_WAD);
        assertEq(BridgeCurve.bandWad(grad, grad), C.BAND_END_WAD);
        assertEq(BridgeCurve.bandWad(grad * 2, grad), C.BAND_END_WAD);
        assertEq(BridgeCurve.bandWad(50_000e18, 0), C.BAND_START_WAD, "no reference TVL stays wide");
        // Geometric mean of $100 and $86,520 is the halfway point on a log TVL axis.
        // Linear-in-ln puts the band at the arithmetic mean of 25% and 3.33% there.
        uint256 midTvl = 2_941e18;
        uint256 mid = BridgeCurve.bandWad(midTvl, grad);
        uint256 expect = (C.BAND_START_WAD + C.BAND_END_WAD) / 2;
        assertApproxEqRel(mid, expect, 0.02e18);
        // $10k is still a wide book. ±3.33% is the graduation end, not the $10k band.
        assertGt(BridgeCurve.bandWad(10_000e18, grad), 0.05e18);
        assertLt(BridgeCurve.bandWad(10_000e18, grad), C.BAND_START_WAD);
        // A larger reference is a larger target, so the same pool TVL is less progress and a wider band.
        assertGt(BridgeCurve.bandWad(50_000e18, 120_000e18), BridgeCurve.bandWad(50_000e18, grad));
        assertGt(BridgeFee.baseFeeBps(50_000e18, 120_000e18), BridgeFee.baseFeeBps(50_000e18, grad));
        assertGt(BridgeFee.dutchCap(50_000e18, 120_000e18), BridgeFee.dutchCap(50_000e18, grad));
        assertLt(BridgeFee.dutchCap(grad, grad), BridgeFee.dutchCap(grad / 10, grad));
    }

    function test_graduationDepthIsAboutThreePointThreePercent() public pure {
        uint256 grad = 86_520e18;
        BridgeCurve.S memory s = _fresh();
        s.x = grad / 2;
        s.protoX = s.x;
        s.y = grad / 2;
        s.protoY = s.y;
        s.vx = 0;
        s.vy = 0;
        s.depthUsd = 0;
        BridgeCurve.retarget(s, s.anchor);
        BridgeCurve.deepen(s, grad);
        uint256 yEff = s.y + s.vy;
        uint256 full = Math.mulDiv(BridgeCurve.tvl(s), C.WAD, yEff);
        assertApproxEqRel(full, C.BAND_END_WAD, 0.02e18);
    }

    function test_shallowBookMovesMoreThanFlatBook() public pure {
        BridgeCurve.S memory shallow = _fresh();
        BridgeCurve.Ctx memory c = _ctx();
        uint256 p0 = BridgeCurve.spot(shallow);
        (shallow,) = BridgeCurve.buyExactIn(shallow, 5e18, c);
        uint256 shallowMove = BridgeCurve.spot(shallow) - p0;

        BridgeCurve.S memory flat = _fresh();
        flat.x = 5_000e18;
        flat.protoX = flat.x;
        flat.y = 5_000e18;
        flat.protoY = flat.y;
        flat.vx = 0;
        flat.vy = 0;
        flat.depthUsd = 0;
        BridgeCurve.deepen(flat, c.gradTvl);
        uint256 f0 = BridgeCurve.spot(flat);
        (flat,) = BridgeCurve.buyExactIn(flat, 5e18, c);
        uint256 flatMove = BridgeCurve.spot(flat) - f0;
        assertGt(shallowMove, flatMove * 5);
    }

    function test_tailPunishesEmptyingASide() public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 1_000e18;
        s.protoY = 1_000e18;
        BridgeCurve.retarget(s, BridgeCurve.spot(s));
        uint256 smallDx = s.x / 100;
        uint256 bigDx = s.x; // f = dx / (x + dx) = 0.5; use a much larger fill
        bigDx = s.x * 20;
        uint256 small = BridgeCurve.sellProceeds(s, smallDx);
        uint256 big = BridgeCurve.sellProceeds(s, bigDx);
        uint256 avgSmall = Math.mulDiv(small, C.WAD, smallDx);
        uint256 avgBig = Math.mulDiv(big, C.WAD, bigDx);
        assertLt(avgBig, (avgSmall * 95) / 100);
    }

    function test_roundingAgainstTheUser() public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 500e18;
        s.protoY = 500e18;
        uint256 dx = 3e18;
        uint256 xE = s.x + s.vx;
        uint256 yE = s.y + s.vy;
        uint256 floorCp = Math.mulDiv(yE, dx, xE - dx);
        assertGe(BridgeCurve.buyCost(s, dx), floorCp);
        uint256 ceilSell = Math.mulDiv(yE, dx, xE + dx);
        assertLe(BridgeCurve.sellProceeds(s, dx), ceilSell);
    }

    function test_g7SellThenBuyLoses() public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 500e18;
        s.protoY = 500e18;
        uint256 dx = 4e18;
        uint256 proceeds = BridgeCurve.sellProceeds(s, dx);
        BridgeCurve.S memory t = s;
        t.x = s.x + dx;
        t.protoX = t.x;
        t.y = s.y - proceeds;
        t.protoY = t.y;
        assertGt(BridgeCurve.buyCost(t, dx), proceeds);
    }

    /// @dev A sell quotes the book as it stands. The buy that follows may deepen. That deepen must
    ///      not make the coins cheaper to repurchase than the sale paid out.
    function test_sellThenBuyDoesNotProfitFromDeepen() public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 200e18;
        s.protoY = 200e18;
        BridgeCurve.Ctx memory c = _ctx();
        uint256 i;
        while (BridgeCurve.spot(s) < s.anchor && i < 40) {
            (s,) = BridgeCurve.buyExactIn(s, 5e18, c);
            unchecked {
                ++i;
            }
        }
        assertGe(BridgeCurve.spot(s), s.anchor);
        uint256 dx = 5e18;
        BridgeCurve.Fill memory sellF;
        (s, sellF) = BridgeCurve.sellExactIn(s, dx, c);
        assertGt(sellF.usdgOut, 0);
        BridgeCurve.Fill memory buyF;
        (s, buyF) = BridgeCurve.buyExactIn(s, sellF.usdgOut, c);
        assertLt(buyF.coinOut, dx, "selling then buying the proceeds back yields fewer coins");
    }

    function test_roundTripWithFeesDoesNotProfit() public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 200e18;
        s.protoY = 200e18;
        BridgeCurve.Ctx memory c = _ctx();
        BridgeCurve.Fill memory buyF;
        (s, buyF) = BridgeCurve.buyExactIn(s, 25e18, c);
        assertGt(buyF.coinOut, 0);
        BridgeCurve.Fill memory sellF;
        (s, sellF) = BridgeCurve.sellExactIn(s, buyF.coinOut, c);
        assertLt(sellF.usdgOut, buyF.usdgIn);
    }

    function test_usdgFloorCutsTheDump() public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 1_000e18;
        s.protoY = 1_000e18;
        BridgeCurve.Ctx memory c = _ctx();
        c.maxUsdgOut = BridgeCurve.floorRoom(s, c.floorBps);
        uint256 floorAmt = (BridgeCurve.principalY(s) * c.floorBps) / C.BPS;
        (s,) = BridgeCurve.sellExactIn(s, s.x * 100, c);
        assertGe(BridgeCurve.principalY(s), floorAmt);
    }

    function test_boostWeightsFeesNotADeposit() public pure {
        BridgeCurve.S memory s = _fresh();
        uint256 spotBefore = BridgeCurve.spot(s);
        BridgeCurve.addLiquidity(s, 0, 10e18);
        assertEq(BridgeCurve.spot(s), spotBefore);
        assertEq(s.lpX, 0, "USDG deposit does not take seed coin");
        assertEq(s.vx, 0, "deposit inside the virtual gap does not flatten");
        assertEq(s.lpY, 10e18);
    }

    function test_anchorRecentersProportionally() public pure {
        BridgeCurve.S memory s = _fresh();
        BridgeCurve.onAnchor(s, 2e18);
        assertEq(BridgeCurve.spot(s), 1.34e18);
        assertEq(s.x, SEED, "recenter does not move real coin");
        assertEq(s.y, 0, "recenter does not move real USDG");
    }

    function test_oversizedUsdgDepositBelowAnchorReverts() public {
        BridgeCurve.S memory s = _fresh();
        // Virtual USDG is ~$51. A $1,000 deposit would pin the discount.
        vm.expectRevert(BridgeCurve.DiscountDeposit.selector);
        this.addUsd(s, 1_000e18);
    }

    function addUsd(BridgeCurve.S memory s, uint256 dy) external pure {
        BridgeCurve.addLiquidity(s, 0, dy);
    }

    function test_depositAboveAnchorMayBeLarge() public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 200e18;
        s.protoY = 200e18;
        s.x = 100e18;
        s.protoX = 100e18;
        BridgeCurve.retarget(s, s.anchor);
        uint256 p = BridgeCurve.spot(s);
        BridgeCurve.addLiquidity(s, 0, 5_000e18);
        assertApproxEqAbs(BridgeCurve.spot(s), p, 2);
    }

    function test_depthDoesNotRatchetDown() public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 5_000e18;
        s.protoY = s.y;
        s.x = 5_000e18;
        s.protoX = s.x;
        s.depthUsd = 0;
        BridgeCurve.retarget(s, s.anchor);
        BridgeCurve.deepen(s, 87_000e18);
        uint256 yEff = s.y + s.vy;
        s.depthUsd = BridgeCurve.tvl(s);
        // A later smaller TVL must not be fed to deepen as a new high. Call with the same state.
        uint256 vx = s.vx;
        uint256 vy = s.vy;
        BridgeCurve.deepen(s, 87_000e18);
        assertEq(s.vx, vx);
        assertEq(s.vy, vy);
        assertGt(yEff, s.y);
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_sellProceedsMonotone(uint256 a, uint256 b) public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 800e18;
        s.protoY = 800e18;
        a = bound(a, 1e12, s.x * 5);
        b = bound(b, 1e12, s.x * 5);
        if (a > b) (a, b) = (b, a);
        assertLe(BridgeCurve.sellProceeds(s, a), BridgeCurve.sellProceeds(s, b));
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_buyCostMonotone(uint256 a, uint256 b) public pure {
        BridgeCurve.S memory s = _fresh();
        s.y = 800e18;
        s.protoY = 800e18;
        uint256 cap = BridgeCurve.maxCoinOut(s);
        a = bound(a, 1, cap);
        b = bound(b, 1, cap);
        if (a > b) (a, b) = (b, a);
        assertLe(BridgeCurve.buyCost(s, a), BridgeCurve.buyCost(s, b));
    }

    /// forge-config: default.fuzz.runs = 32
    function testFuzz_noFeeRoundTripProfit(uint256 usdgIn) public pure {
        usdgIn = bound(usdgIn, 1e15, 30e18);
        BridgeCurve.S memory s = _fresh();
        s.y = 300e18;
        s.protoY = 300e18;
        BridgeCurve.Ctx memory c = _ctx();
        BridgeCurve.Fill memory buyF;
        (s, buyF) = BridgeCurve.buyExactIn(s, usdgIn, c);
        if (buyF.coinOut == 0) return;
        BridgeCurve.Fill memory sellF;
        (, sellF) = BridgeCurve.sellExactIn(s, buyF.coinOut, c);
        assertLt(sellF.usdgOut, buyF.usdgIn);
    }
}

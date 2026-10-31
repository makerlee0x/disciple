// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";

contract BridgeFeeTest is Test {
    function test_baseSlidesFromTwoPercentToPointThree() public pure {
        assertEq(BridgeFee.baseFeeBps(0, 87_000e18), 200);
        assertEq(BridgeFee.baseFeeBps(87_000e18, 87_000e18), 30);
        assertEq(BridgeFee.baseFeeBps(1, 0), 200, "unknown graduation stays at 2%");
        uint256 mid = BridgeFee.baseFeeBps(87_000e18 / 2, 87_000e18);
        assertGt(mid, 30);
        assertLt(mid, 200);
        // $10k is not graduation. The rough python sim used 0.3% there; this schedule does not.
        assertGt(BridgeFee.baseFeeBps(10_000e18, 87_000e18), 150);
    }

    function test_feeIsOnlyTheProgressSlide() public pure {
        uint256 grad = 86_520e18;
        uint256 quiet = BridgeFee.baseFeeBps(4_000e18, grad);
        uint256 same = BridgeFee.baseFeeBps(4_000e18, grad);
        assertEq(quiet, same);
        assertGt(quiet, C.FEE_FLOOR_BPS);
        assertLt(quiet, C.FEE_TINY_BPS);
        assertEq(BridgeFee.baseFeeBps(grad, grad), C.FEE_FLOOR_BPS);
        // Halfway to the target is halfway from 2% to 0.3%.
        assertEq(BridgeFee.baseFeeBps(grad / 2, grad), (C.FEE_TINY_BPS + C.FEE_GRAD_BPS) / 2);
    }

    function test_decayHalfLifeOnlyShrinks() public pure {
        uint256 v = 1_000e18;
        assertEq(BridgeFee.decayed(v, 0, 1 hours), v);
        assertEq(BridgeFee.decayed(v, 1 hours, 1 hours), v / 2);
        assertEq(BridgeFee.decayed(v, 2 hours, 1 hours), v / 4);
        assertEq(BridgeFee.decayed(v, 64 hours, 1 hours), 0);
        assertEq(BridgeFee.decayed(0, 1 hours, 1 hours), 0);
        uint256 halfHour = BridgeFee.decayed(v, 30 minutes, 1 hours);
        // 2^(-0.5) ≈ 0.7071, scaled by the 1_000e18 principal.
        assertApproxEqRel(halfHour, 707_106_781_186_547_524 * 1000, 1e14);
        assertLt(halfHour, v);
        assertGt(BridgeFee.decayed(v, 1, 1 hours), BridgeFee.decayed(v, 30 minutes, 1 hours));
    }

    function test_boostDecaysToFloor() public pure {
        uint256 grad = 86_520e18;
        assertEq(BridgeFee.boostWad(0, grad), C.BOOST_START_WAD);
        assertEq(BridgeFee.boostWad(0, 0), C.BOOST_START_WAD, "unknown graduation stays at 5x");
        assertEq(C.BOOST_START_WAD, 5e18);
        assertEq(BridgeFee.boostWad(grad, grad), C.BOOST_END_WAD);
        assertEq(BridgeFee.boostWad(grad * 5, grad), C.BOOST_END_WAD);
        uint256 mid = BridgeFee.boostWad(grad / 2, grad);
        assertGt(mid, C.BOOST_END_WAD);
        assertLt(mid, C.BOOST_START_WAD);
        // $10k of an $86.5k graduation is still most of the way toward 5x (about 4.6x).
        assertGt(BridgeFee.boostWad(10_000e18, grad), 4e18);
    }

    function test_buffer() public pure {
        assertEq(BridgeFee.buffer(1_000e18), 500e18);
        assertEq(BridgeFee.buffer(20_000e18), 1_000e18);
    }
}

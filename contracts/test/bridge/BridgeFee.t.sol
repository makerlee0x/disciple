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

    function test_direction() public pure {
        uint256 toward = BridgeFee.directional(200, 0.5e18, 0.8e18, 1e18);
        uint256 away = BridgeFee.directional(200, 0.8e18, 0.5e18, 1e18);
        uint256 flat = BridgeFee.directional(200, 1e18, 1e18, 1e18);
        assertEq(toward, 100);
        assertEq(away, 300);
        assertEq(flat, 200);
    }

    function test_staleRampAndCap() public pure {
        assertEq(BridgeFee.applyStale(200, 30 minutes), 200);
        assertEq(BridgeFee.applyStale(200, 30 minutes + 2 hours), 1_000);
        assertEq(BridgeFee.applyStale(200, 30 days), 1_000);
        assertEq(BridgeFee.applyStale(500, 30 days), C.FEE_ABS_CAP_BPS);
        uint256 mid = BridgeFee.applyStale(200, 30 minutes + 1 hours);
        assertGt(mid, 200);
        assertLt(mid, 1_000);
    }

    function test_boostDecaysToFloor() public pure {
        uint256 grad = 86_520e18;
        assertEq(BridgeFee.boostWad(0, grad), C.BOOST_START_WAD);
        assertEq(BridgeFee.boostWad(0, 0), C.BOOST_START_WAD, "unknown graduation stays at 3.3x");
        assertEq(BridgeFee.boostWad(grad, grad), C.BOOST_END_WAD);
        assertEq(BridgeFee.boostWad(grad * 5, grad), C.BOOST_END_WAD);
        uint256 mid = BridgeFee.boostWad(grad / 2, grad);
        assertGt(mid, C.BOOST_END_WAD);
        assertLt(mid, C.BOOST_START_WAD);
        // $10k is not graduation. The boost is still near 3.3x there.
        assertGt(BridgeFee.boostWad(10_000e18, grad), 3e18);
    }

    function test_buffer() public pure {
        assertEq(BridgeFee.buffer(1_000e18), 500e18);
        assertEq(BridgeFee.buffer(20_000e18), 1_000e18);
    }
}

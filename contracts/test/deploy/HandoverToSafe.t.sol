// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {HandoverToSafe} from "../../script/HandoverToSafe.s.sol";

contract MockOwned2Step {
    address public owner;
    address public pendingOwner;

    constructor(address o) {
        owner = o;
    }

    function transferOwnership(address n) external {
        require(msg.sender == owner, "owner");
        pendingOwner = n;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "pending");
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}

contract MockSafe {
    uint256 public threshold;
    address[] internal owners;

    constructor(uint256 t, uint256 n) {
        threshold = t;
        for (uint256 i; i < n; ++i) owners.push(address(uint160(0x5afe + i)));
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function exec(address to, bytes calldata data) external {
        (bool ok, bytes memory r) = to.call(data);
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
}

contract HandoverToSafeTest is Test {
    string[8] internal TL = [
        "LAUNCHPAD", "FEE_ROUTER", "QUOTE_PRICER", "QUOTE_PROBE", "MIGRATION", "DISCIPLE_ROUTER", "REFERRALS", "ANON_LAUNCHER"
    ];
    address internal deployer = DEFAULT_SENDER;

    function _setUp(MockSafe safe) internal returns (MockOwned2Step[8] memory cs, MockOwned2Step rv) {
        vm.setEnv("SAFE", vm.toString(address(safe)));
        for (uint256 i; i < 8; ++i) {
            cs[i] = new MockOwned2Step(deployer);
            vm.setEnv(TL[i], vm.toString(address(cs[i])));
        }
        rv = new MockOwned2Step(deployer);
        vm.setEnv("REWARDS_VAULT", vm.toString(address(rv)));
    }

    function test_handover_safeOnlyByDefault() public {
        MockSafe safe = new MockSafe(2, 3);
        (MockOwned2Step[8] memory cs, MockOwned2Step rv) = _setUp(safe);
        vm.setEnv("USE_TIMELOCK", "false");
        new HandoverToSafe().run();
        for (uint256 i; i < 8; ++i) assertEq(cs[i].pendingOwner(), address(safe));
        assertEq(rv.pendingOwner(), address(safe));
        safe.exec(address(cs[0]), abi.encodeWithSignature("acceptOwnership()"));
        assertEq(cs[0].owner(), address(safe));
    }

    function test_handover_timelockedThenAccepted() public {
        MockSafe safe = new MockSafe(2, 3);
        (MockOwned2Step[8] memory cs, MockOwned2Step rv) = _setUp(safe);
        vm.setEnv("USE_TIMELOCK", "true");
        HandoverToSafe s = new HandoverToSafe();
        vm.recordLogs();
        s.run();

        address tl = cs[0].pendingOwner();
        assertTrue(tl != address(safe) && tl.code.length != 0, "timelock nominated");
        TimelockController t = TimelockController(payable(tl));
        assertEq(t.getMinDelay(), 48 hours);
        assertTrue(t.hasRole(t.PROPOSER_ROLE(), address(safe)));
        assertTrue(t.hasRole(t.EXECUTOR_ROLE(), address(safe)));
        assertTrue(t.hasRole(t.CANCELLER_ROLE(), address(safe)));
        assertFalse(t.hasRole(t.DEFAULT_ADMIN_ROLE(), deployer));
        for (uint256 i; i < 8; ++i) {
            assertEq(cs[i].pendingOwner(), tl);
            assertEq(cs[i].owner(), deployer);
        }
        assertEq(rv.pendingOwner(), address(safe), "rewards vault straight to Safe");

        // The Safe schedules acceptOwnership through the timelock; it can't run before the delay.
        bytes memory accept = abi.encodeWithSignature("acceptOwnership()");
        safe.exec(tl, abi.encodeCall(t.schedule, (address(cs[0]), 0, accept, bytes32(0), bytes32(0), 48 hours)));
        vm.expectRevert();
        safe.exec(tl, abi.encodeCall(t.execute, (address(cs[0]), 0, accept, bytes32(0), bytes32(0))));
        vm.warp(block.timestamp + 48 hours);
        safe.exec(tl, abi.encodeCall(t.execute, (address(cs[0]), 0, accept, bytes32(0), bytes32(0))));
        assertEq(cs[0].owner(), tl);

        // A stranger can't schedule anything.
        vm.prank(address(0xbad));
        vm.expectRevert();
        t.schedule(address(cs[1]), 0, accept, bytes32(0), bytes32(0), 48 hours);
    }

    function test_handover_rejectsNon2of3() public {
        MockSafe safe = new MockSafe(1, 3);
        _setUp(safe);
        HandoverToSafe s = new HandoverToSafe();
        vm.expectRevert(bytes("Handover: SAFE is not 2-of-3"));
        s.run();
    }
}

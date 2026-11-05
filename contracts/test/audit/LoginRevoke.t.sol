// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LoginGate} from "../../src/LoginGate.sol";

/// @notice Audit F-05: revoke must invalidate outstanding attestations; re-attest at new epoch works.
contract LoginRevokeTest is Test {
    LoginGate gate;
    uint256 attesterPk = 0xA77E57;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address coin = makeAddr("coin");

    function setUp() public {
        gate = new LoginGate(owner, vm.addr(attesterPk));
    }

    function _sign(address wallet, uint64 exp, address c, uint64 e) internal view returns (bytes memory sig) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, gate.digest(wallet, exp, c, e));
        sig = abi.encodePacked(r, s, v);
    }

    function _attest(address wallet, uint64 exp, address c) internal {
        uint64 e = gate.epoch(wallet, c);
        gate.attest(wallet, exp, c, _sign(wallet, exp, c, e));
    }

    function test_revokeThenReplayOldAttestationFails() public {
        uint64 exp = uint64(block.timestamp + 12 hours);
        uint64 e0 = gate.epoch(alice, address(0));
        bytes memory sig = _sign(alice, exp, address(0), e0);
        gate.attest(alice, exp, address(0), sig);
        assertEq(gate.verifiedUntil(alice, address(0)), exp);

        vm.prank(owner);
        gate.revoke(alice, address(0));
        assertEq(gate.verifiedUntil(alice, address(0)), 0);
        assertEq(gate.epoch(alice, address(0)), e0 + 1);

        // Replay the original signature under the new epoch must fail.
        vm.expectRevert(LoginGate.BadSignature.selector);
        gate.attest(alice, exp, address(0), sig);
        assertEq(gate.verifiedUntil(alice, address(0)), 0);
    }

    function test_reattestAtNewEpochWorks() public {
        uint64 exp1 = uint64(block.timestamp + 12 hours);
        _attest(alice, exp1, address(0));
        assertEq(gate.verifiedUntil(alice, address(0)), exp1);

        vm.prank(owner);
        gate.revoke(alice, address(0));
        assertEq(gate.verifiedUntil(alice, address(0)), 0);

        uint64 exp2 = uint64(block.timestamp + 6 hours);
        _attest(alice, exp2, address(0));
        assertEq(gate.verifiedUntil(alice, address(0)), exp2);
        assertEq(gate.epoch(alice, address(0)), 1);
    }

    function test_coinRevokeBlocksGlobalFallback() public {
        uint64 exp = uint64(block.timestamp + 12 hours);
        _attest(alice, exp, address(0)); // global
        assertEq(gate.verifiedUntil(alice, coin), exp, "global covers coin");

        vm.prank(owner);
        gate.revoke(alice, coin); // coin-specific revoke wins over global
        assertEq(gate.verifiedUntil(alice, coin), 0, "coin revoke blocks global");
        assertEq(gate.verifiedUntil(alice, address(0)), exp, "global slot itself intact");

        // Re-attest at coin scope restores coin access.
        _attest(alice, exp, coin);
        assertEq(gate.verifiedUntil(alice, coin), exp);
    }

    function test_globalRevokeInvalidatesPriorCoinAttestation() public {
        uint64 exp = uint64(block.timestamp + 12 hours);
        _attest(alice, exp, coin);
        assertEq(gate.verifiedUntil(alice, coin), exp);

        vm.prank(owner);
        gate.revoke(alice, address(0)); // global revoke wins over coin-specific
        assertEq(gate.verifiedUntil(alice, coin), 0, "global revoke clears coin coverage");
        assertEq(gate.verifiedUntil(alice, address(0)), 0);

        // Coin re-attest under new walletGen works without a global attest.
        _attest(alice, exp, coin);
        assertEq(gate.verifiedUntil(alice, coin), exp);
    }
}

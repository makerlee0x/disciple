// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LoginGate} from "../../src/LoginGate.sol";

/// @notice Audit F-05: global-only login, epoch-bound signatures, no coin-scoped ABI.
contract LoginRevokeTest is Test {
    LoginGate gate;
    uint256 attesterPk = 0xA77E57;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        gate = new LoginGate(owner, vm.addr(attesterPk));
    }

    function _sign(address wallet, uint64 exp, uint64 e) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, gate.digest(wallet, exp, e));
        return abi.encodePacked(r, s, v);
    }

    function _attest(address wallet, uint64 exp) internal {
        gate.attest(wallet, exp, _sign(wallet, exp, gate.epoch(wallet)));
    }

    function test_revokeThenReplayOldAttestationFails() public {
        uint64 exp = uint64(block.timestamp + 12 hours);
        bytes memory sig = _sign(alice, exp, gate.epoch(alice));
        gate.attest(alice, exp, sig);
        assertEq(gate.verifiedUntil(alice), exp);
        vm.prank(owner);
        gate.revoke(alice);
        assertEq(gate.verifiedUntil(alice), 0);
        assertEq(gate.epoch(alice), 1);
        vm.expectRevert(LoginGate.BadSignature.selector);
        gate.attest(alice, exp, sig);
        assertEq(gate.verifiedUntil(alice), 0);
    }

    function test_reattestAtNewEpochDoesNotReviveOldLongerExpiry() public {
        _attest(alice, uint64(block.timestamp + 12 hours));
        vm.prank(owner);
        gate.revoke(alice);
        uint64 exp = uint64(block.timestamp + 1 hours);
        _attest(alice, exp);
        assertEq(gate.verifiedUntil(alice), exp);
    }

    function test_revokeInvalidatesUnsubmittedSignature() public {
        uint64 exp = uint64(block.timestamp + 12 hours);
        bytes memory sig = _sign(alice, exp, 0);
        vm.prank(owner);
        gate.revoke(alice);
        vm.expectRevert(LoginGate.BadSignature.selector);
        gate.attest(alice, exp, sig);
    }

    function test_revokeIsPerWalletNotPerCoin() public {
        uint64 exp = uint64(block.timestamp + 12 hours);
        _attest(alice, exp);
        _attest(bob, exp);
        vm.prank(owner);
        gate.revoke(alice);
        assertEq(gate.verifiedUntil(alice), 0);
        assertEq(gate.verifiedUntil(bob), exp);
        assertEq(gate.epoch(bob), 0);
    }

    function test_onlyOwnerCanRevoke() public {
        vm.prank(alice);
        vm.expectRevert(LoginGate.OnlyOwner.selector);
        gate.revoke(alice);
        assertEq(gate.epoch(alice), 0);
    }

    function test_repeatedRevokeCannotReplayPreviousEpoch() public {
        vm.prank(owner);
        gate.revoke(alice);
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(alice, exp, 1);
        gate.attest(alice, exp, sig);
        vm.prank(owner);
        gate.revoke(alice);
        assertEq(gate.epoch(alice), 2);
        vm.expectRevert(LoginGate.BadSignature.selector);
        gate.attest(alice, exp, sig);
    }

    function test_sameEpochAttestDoesNotShortenLogin() public {
        uint64 exp = uint64(block.timestamp + 12 hours);
        _attest(alice, exp);
        _attest(alice, uint64(block.timestamp + 1 hours));
        assertEq(gate.verifiedUntil(alice), exp);
    }

    function test_signatureCannotBeUsedForAnotherWallet() public {
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(alice, exp, 0);
        vm.expectRevert(LoginGate.BadSignature.selector);
        gate.attest(bob, exp, sig);
    }

    function test_coinScopedSelectorsAreRemoved() public {
        (bool ok, bytes memory result) = address(gate)
            .call(
                abi.encodeWithSignature(
                    "attest(address,uint64,address,bytes)", alice, uint64(block.timestamp + 1 hours), bob, bytes("")
                )
            );
        assertFalse(ok);
        assertEq(result.length, 0, "removed selector has no handler");
        vm.prank(owner);
        (ok,) = address(gate).call(abi.encodeWithSignature("revoke(address,address)", alice, bob));
        assertFalse(ok);
        (ok,) = address(gate).staticcall(abi.encodeWithSignature("verifiedUntil(address,address)", alice, bob));
        assertFalse(ok);
    }

    function test_globalTypedDataParity() public view {
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes32 typeHash = keccak256("LoginAttestation(address wallet,uint64 expiry,uint64 epoch)");
        assertEq(gate.LOGIN_TYPEHASH(), typeHash);
        bytes32 structHash = keccak256(abi.encode(typeHash, alice, exp, uint64(0)));
        assertEq(gate.digest(alice, exp), keccak256(abi.encodePacked(hex"1901", gate.domainSeparator(), structHash)));
    }
}

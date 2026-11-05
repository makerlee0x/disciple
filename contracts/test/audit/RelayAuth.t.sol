// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EntryPoint} from "../vendor/aa-v07/core/EntryPoint.sol";
import {IAccount} from "../vendor/aa-v07/interfaces/IAccount.sol";
import {PackedUserOperation as Op} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";

contract RelayValidationAccount is IAccount {
    address immutable ep;
    address immutable owner;
    constructor(address ep_, address owner_) { ep = ep_; owner = owner_; }
    receive() external payable {}
    function validateUserOp(Op calldata op, bytes32 hash, uint256 missing) external returns (uint256) {
        require(msg.sender == ep);
        if (missing != 0) { (bool ok,) = payable(ep).call{value: missing}(""); ok; }
        return ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(hash), op.signature) == owner ? 0 : 1;
    }
    function execute() external view { require(msg.sender == ep); }
}

/// @notice Real local EntryPoint v0.7 proves exact handleOps simulation rejects bad signature/nonce/funding/code.
///         Snapshot/revert models eth_call; the relayer submits only after success. No network or live transaction.
contract RelayAuthTest is Test {
    EntryPoint ep;
    RelayValidationAccount account;
    uint256 constant PK = 0xA11CE;
    address payable beneficiary;
    uint256 broadcasts;

    function setUp() public {
        ep = new EntryPoint();
        account = new RelayValidationAccount(address(ep), vm.addr(PK));
        vm.deal(address(account), 1 ether);
        beneficiary = payable(makeAddr("relayer"));
        vm.txGasPrice(1 gwei);
    }
    function _op(uint256 signingKey) internal view returns (Op memory op) {
        op.sender = address(account);
        op.callData = abi.encodeCall(account.execute, ());
        op.accountGasLimits = bytes32((uint256(300000) << 128) | 150000);
        op.preVerificationGas = 60000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 1 gwei);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingKey, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)));
        op.signature = abi.encodePacked(r, s, v);
    }
    function _simulateThenSubmit(Op memory op) internal returns (bool ok) {
        Op[] memory ops = new Op[](1); ops[0] = op;
        uint256 snap = vm.snapshotState();
        (ok,) = address(ep).call(abi.encodeCall(ep.handleOps, (ops, beneficiary)));
        vm.revertToState(snap); // eth_call does not consume nonce/funding
        if (ok) { broadcasts++; ep.handleOps(ops, beneficiary); }
    }
    function _rejected(Op memory op) internal {
        uint256 bal = address(account).balance;
        assertFalse(_simulateThenSubmit(op));
        assertEq(broadcasts, 0, "never submit rejected operation");
        assertEq(beneficiary.balance, 0);
        assertEq(address(account).balance, bal);
        assertEq(ep.getNonce(address(account), 0), 0);
    }
    function test_forgedCallDataRejectedWithoutPaying() public {
        Op memory op = _op(PK); op.callData = hex"deadbeef"; _rejected(op);
    }
    function test_wrongSignatureRejectedWithoutPaying() public { _rejected(_op(0xBAD)); }
    function test_wrongNonceRejectedWithoutPaying() public {
        Op memory op = _op(PK); op.nonce = 7;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)));
        op.signature = abi.encodePacked(r, s, v); _rejected(op);
    }
    function test_unfundedAccountRejectedWithoutPaying() public {
        vm.deal(address(account), 0); _rejected(_op(PK));
    }
    function test_wrongImplementationRejectedWithoutPaying() public {
        Op memory op = _op(PK); op.sender = address(new EntryPoint()); _rejected(op);
    }
    function test_validOperationPassesAndReimbursesRelayer() public {
        assertTrue(_simulateThenSubmit(_op(PK)));
        assertEq(broadcasts, 1); assertEq(ep.getNonce(address(account), 0), 1);
        assertGt(beneficiary.balance, 0, "valid account reimburses gas");
    }
}

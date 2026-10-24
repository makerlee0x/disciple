// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymasterTestBase} from "./PaymasterTestBase.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {PackedUserOperation as PmOp} from "../../src/paymaster/IPaymasterV07.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice AUDIT #141 L-2: per-op quotes (pm_getPaymasterData — launches, graduating buys, the larger maxTokenCost
///         tiers) are signed over getOpHash and bind one exact userOp, so they can't be reused as an allowance.
///         Allowances (getHash, standard trade envelope) stay reusable (PaymasterAllowance.t.sol).
contract PaymasterOpQuoteTest is PaymasterTestBase {
    address sink = makeAddr("sink");
    uint48 until;
    uint48 afterTs;
    uint256 big; // a "launch tier" maxTokenCost: well above the trade envelope, ≤ maxCostCap

    function setUp() public {
        _setUp(18);
        until = uint48(block.timestamp + 180);
        afterTs = uint48(block.timestamp - 10);
        big = _maxTok() * 4;
    }

    function _signOp(EpOp memory op, uint256 m) internal view returns (EpOp memory) {
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), until, afterTs, rate, m, new bytes(65));
        PmOp memory po = abi.decode(abi.encode(op), (PmOp));
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(this.opHash(po, m));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(signerPk, h);
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), until, afterTs, rate, m, rr, s, v);
        return op;
    }

    /// @dev calldata hop so getOpHash gets a calldata op
    function opHash(PmOp calldata po, uint256 m) external view returns (bytes32) {
        return pm.getOpHash(po, until, afterTs, rate, m);
    }

    function _aa34(uint256 idx) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOp.selector, idx, "AA34 signature error");
    }

    function test_opQuote_validForItsOp() public {
        EpOp memory op = _signAcct(_signOp(_op(_approveThen(big, _transferCall(sink, 1))), big));
        (bool ok,, uint256 charged) = _sendRecord(op);
        assertTrue(ok);
        assertGt(charged, 0);
        assertEq(usdg.balanceOf(sink), 1);
    }

    /// @dev The core L-2 case: the same paymasterAndData (big maxTokenCost) on the sender's NEXT op is refused.
    function test_opQuote_notReusableByNextOp() public {
        EpOp memory op1 = _signAcct(_signOp(_op(_approveThen(big, _transferCall(sink, 1))), big));
        _send(op1);
        EpOp memory op2 = _op(_approveThen(big, _transferCall(sink, 1))); // next nonce, same calls
        op2.paymasterAndData = op1.paymasterAndData;
        op2 = _signAcct(op2);
        vm.expectRevert(_aa34(0));
        _send(op2);
    }

    function test_opQuote_boundToCallData() public {
        EpOp memory op = _signOp(_op(_approveThen(big, _transferCall(sink, 1))), big);
        op.callData = _approveThen(big, _transferCall(sink, 2));
        op = _signAcct(op);
        vm.expectRevert(_aa34(0));
        _send(op);
    }

    function test_opQuote_boundToGas() public {
        EpOp memory op = _signOp(_op(_approveThen(big, _transferCall(sink, 1))), big);
        op.accountGasLimits = bytes32((VERIF_GAS << 128) | (CALL_GAS * 3));
        op = _signAcct(op);
        vm.expectRevert(_aa34(0));
        _send(op);
    }

    function test_opQuote_boundToPaymasterGas() public {
        EpOp memory op = _signOp(_op(_approveThen(big, _transferCall(sink, 1))), big);
        bytes memory pmd = op.paymasterAndData;
        assembly {
            // bump paymasterPostOpGasLimit (bytes 36..52) low word: the 16-byte field ends at byte 52
            let p := add(add(pmd, 32), 36)
            mstore8(add(p, 15), 0xff)
        }
        op.paymasterAndData = pmd;
        op = _signAcct(op);
        vm.expectRevert(_aa34(0));
        _send(op);
    }

    /// @dev An op-quote signature is never accepted as an allowance for another sender either.
    function test_opQuote_wrongSender() public {
        EpOp memory op = _signOp(_op(_approveThen(big, _transferCall(sink, 1))), big);
        address other = address(0xBEEF);
        op.sender = other;
        PmOp memory po = abi.decode(abi.encode(op), (PmOp));
        assertTrue(this.opHash(po, big) != pm.getHash(other, until, afterTs, rate, big));
    }

    /// @dev Byte parity with web/lib/aa/paymaster.ts paymasterQuoteHash (same vector in scripts/test-paymaster.mts).
    function test_opHashVector_matchesWeb() public {
        assertEq(pm.OP_QUOTE_TYPEHASH(), keccak256("DisciplePaymaster.OpQuote(v1)"));
        address at = 0x1111111111111111111111111111111111111111;
        vm.etch(at, address(pm).code);
        vm.chainId(46630);
        PmOp memory po;
        po.sender = 0x3333333333333333333333333333333333333333;
        po.nonce = 7;
        po.initCode = hex"";
        po.callData = hex"deadbeef";
        po.accountGasLimits = bytes32((uint256(350_000) << 128) | 1_800_000);
        po.preVerificationGas = 60_000;
        po.gasFees = bytes32((uint256(1 gwei) << 128) | 2 gwei);
        po.paymasterAndData = abi.encodePacked(at, uint128(120_000), uint128(80_000), new bytes(141));
        bytes32 h = this.opHashAt(DisciplePaymaster(at), po);
        assertEq(h, OP_VECTOR);
    }

    bytes32 constant OP_VECTOR = 0x2d991e8c73ba211ee1c6e0239394b0ce120ebef3f72bc030d71abb2561fa309f;

    function opHashAt(DisciplePaymaster p, PmOp calldata po) external view returns (bytes32) {
        return p.getOpHash(po, 1_790_000_180, 1_789_999_970, 3000e18, 123456789012345678);
    }
}

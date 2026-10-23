// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EntryPoint} from "../vendor/aa-v07/core/EntryPoint.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {IAccount} from "../vendor/aa-v07/interfaces/IAccount.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {PackedUserOperation as PmOp} from "../../src/paymaster/IPaymasterV07.sol";

contract MockUSDG is ERC20 {
    uint8 internal immutable _dec;

    constructor(uint8 d) ERC20("Global Dollar", "USDG") {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @dev Minimal v0.7 account with MAv2-shaped execute / executeBatch((address,uint256,bytes)[]) and executeUserOp.
contract MiniAccount is IAccount {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable entryPoint;
    address public immutable owner;

    constructor(address ep, address o) {
        entryPoint = ep;
        owner = o;
    }

    receive() external payable {}

    function validateUserOp(EpOp calldata op, bytes32 h, uint256 missing) external returns (uint256) {
        require(msg.sender == entryPoint, "ep");
        address r = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(h), op.signature);
        if (missing != 0) {
            (bool ok,) = payable(msg.sender).call{value: missing}("");
            ok;
        }
        return r == owner ? 0 : 1;
    }

    function execute(address t, uint256 v, bytes calldata d) external {
        require(msg.sender == entryPoint || msg.sender == address(this), "auth");
        _call(t, v, d);
    }

    function executeBatch(Call[] calldata calls) external {
        require(msg.sender == entryPoint || msg.sender == address(this), "auth");
        for (uint256 i; i < calls.length; ++i) {
            _call(calls[i].target, calls[i].value, calls[i].data);
        }
    }

    /// @dev IAccountExecute: EntryPoint passes the whole op; run callData[4:] (MAv2 style).
    function executeUserOp(EpOp calldata op, bytes32) external {
        require(msg.sender == entryPoint, "ep");
        (bool ok, bytes memory r) = address(this).call(op.callData[4:]);
        if (!ok) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }

    function _call(address t, uint256 v, bytes memory d) internal {
        (bool ok, bytes memory r) = t.call{value: v}(d);
        if (!ok) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }
}

contract Reverter {
    error Nope();

    function fail() external pure {
        revert Nope();
    }
}

abstract contract PaymasterTestBase is Test {
    EntryPoint ep;
    MockUSDG usdg;
    DisciplePaymaster pm;
    MiniAccount acct;
    Reverter rev;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address bundler = makeAddr("bundler");
    uint256 signerPk = 0xA11CE;
    address signer;
    uint256 userPk = 0xB0B;
    address user;

    uint256 constant CALL_GAS = 300_000;
    uint256 constant VERIF_GAS = 150_000;
    uint256 constant PVG = 60_000;
    uint256 constant PM_VERIF_GAS = 120_000;
    uint256 constant PM_POSTOP_GAS = 80_000;
    uint256 constant MAX_FEE = 2 gwei;
    uint256 constant TIP = 1 gwei;
    uint256 constant POST_OP_GAS = 30_000;

    uint256 rate; // USDG raw per 1e18 wei
    uint8 dec;

    function _setUp(uint8 d) internal {
        dec = d;
        rate = 3000 * 10 ** d; // 1 ETH = 3000 USDG
        signer = vm.addr(signerPk);
        user = vm.addr(userPk);
        ep = new EntryPoint();
        usdg = new MockUSDG(d);
        pm = new DisciplePaymaster(
            address(ep), address(usdg), owner, signer, treasury, rate / 10, rate * 10, 100 * 10 ** d, POST_OP_GAS
        );
        acct = new MiniAccount(address(ep), user);
        rev = new Reverter();
        vm.deal(address(this), 10 ether);
        pm.deposit{value: 1 ether}();
        usdg.mint(address(acct), 1_000 * 10 ** d);
        vm.fee(0.5 gwei);
        vm.warp(1_790_000_000);
    }

    // ───────── op building ─────────

    function _maxCost() internal pure returns (uint256) {
        return (CALL_GAS + VERIF_GAS + PVG + PM_VERIF_GAS + PM_POSTOP_GAS) * MAX_FEE;
    }

    function _maxTok() internal view returns (uint256) {
        return pm.tokenCost(_maxCost(), rate) + pm.debtOf(address(acct));
    }

    function _approve(uint256 amt) internal view returns (MiniAccount.Call memory) {
        return MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), amt)));
    }

    function _batch(MiniAccount.Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(MiniAccount.executeBatch, (calls));
    }

    function _approveThen(uint256 amt, MiniAccount.Call memory next) internal view returns (bytes memory) {
        MiniAccount.Call[] memory c = new MiniAccount.Call[](2);
        c[0] = _approve(amt);
        c[1] = next;
        return _batch(c);
    }

    function _transferCall(address to, uint256 a) internal view returns (MiniAccount.Call memory) {
        return MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.transfer, (to, a)));
    }

    uint256 nonceKey;

    function _op(bytes memory callData) internal returns (EpOp memory op) {
        op.sender = address(acct);
        op.nonce = ep.getNonce(address(acct), uint192(nonceKey));
        op.callData = callData;
        op.accountGasLimits = bytes32((VERIF_GAS << 128) | CALL_GAS);
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((TIP << 128) | MAX_FEE);
    }

    function _pmPrefix() internal view returns (bytes memory) {
        return abi.encodePacked(address(pm), uint128(PM_VERIF_GAS), uint128(PM_POSTOP_GAS));
    }

    function _signPm(EpOp memory op, uint48 until, uint48 afterTs, uint256 r, uint256 maxTok, uint256 pk)
        internal
        view
        returns (EpOp memory)
    {
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), until, afterTs, r, maxTok, new bytes(65));
        PmOp memory po = abi.decode(abi.encode(op), (PmOp));
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(pm.getHash(po, until, afterTs, r, maxTok));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, h);
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), until, afterTs, r, maxTok, rr, s, v);
        return op;
    }

    function _signAcct(EpOp memory op) internal view returns (EpOp memory) {
        bytes32 h = ep.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, MessageHashUtils.toEthSignedMessageHash(h));
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    function _full(bytes memory callData, uint256 r, uint256 maxTok) internal returns (EpOp memory op) {
        op = _op(callData);
        op = _signPm(op, uint48(block.timestamp + 120), uint48(block.timestamp - 10), r, maxTok, signerPk);
        op = _signAcct(op);
    }

    function _send(EpOp memory op) internal {
        EpOp[] memory ops = new EpOp[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
    }

    /// @dev Sends and returns (success, actualGasCost) from UserOperationEvent and the charged token amount.
    function _sendRecord(EpOp memory op) internal returns (bool success, uint256 actualGasCost, uint256 charged) {
        vm.recordLogs();
        _send(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, success, actualGasCost,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            } else if (logs[i].topics[0] == DisciplePaymaster.UserOperationCharged.selector) {
                (charged,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
    }

    function _aa33(bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA33 reverted", inner);
    }
}

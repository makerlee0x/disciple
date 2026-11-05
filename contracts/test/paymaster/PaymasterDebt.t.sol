// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {PaymasterTestBase, MiniAccount} from "./PaymasterTestBase.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {PackedUserOperation as PmOp, PostOpMode} from "../../src/paymaster/IPaymasterV07.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";

/// @notice AUDIT F-01 repro: disposable accounts approve+drain the same 1,000 USDG through the paymaster.
///         Before the fix, three ops succeed, treasury receives 0, deposit falls, each sender is left in debt.
///         After the fix, validation requires a standing allowance and precharges before execution, so the
///         unpaid rotation exploit fails.
contract PaymasterDebtTest is PaymasterTestBase {
    address attacker = makeAddr("attacker");
    uint256 constant N = 3;

    uint256[N] ownerPks;
    MiniAccount[N] accts;

    function setUp() public {
        _setUp(18);
        for (uint256 i; i < N; ++i) {
            ownerPks[i] = uint256(keccak256(abi.encodePacked("f01-owner", i)));
            accts[i] = new MiniAccount(address(ep), vm.addr(ownerPks[i]));
        }
        usdg.mint(address(accts[0]), 1_000 * 10 ** dec);
        assertEq(usdg.balanceOf(address(accts[0])), 1_000 * 10 ** dec);
    }

    function _signPmSender(address sender, uint48 until, uint48 afterTs, uint256 r, uint256 maxTok)
        internal
        view
        returns (bytes memory)
    {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(pm.getHash(sender, until, afterTs, r, maxTok));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(signerPk, h);
        return abi.encodePacked(
            address(pm), uint128(PM_VERIF_GAS), uint128(PM_POSTOP_GAS), until, afterTs, r, maxTok, rr, s, v
        );
    }

    function _signAcctPk(EpOp memory op, uint256 pk) internal view returns (EpOp memory) {
        bytes32 h = ep.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(h));
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    /// @dev approve(paymaster, maxTok) then transfer the full *pre-op* balance to `next` (the audit PoC shape).
    function _drainOp(uint256 idx, address next, uint256 maxTok) internal returns (EpOp memory op) {
        MiniAccount a = accts[idx];
        uint256 bal = usdg.balanceOf(address(a));
        MiniAccount.Call[] memory c = new MiniAccount.Call[](2);
        c[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), maxTok)));
        c[1] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.transfer, (next, bal)));
        op.sender = address(a);
        op.nonce = ep.getNonce(address(a), 0);
        op.callData = abi.encodeCall(MiniAccount.executeBatch, (c));
        op.accountGasLimits = bytes32((VERIF_GAS << 128) | CALL_GAS);
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((TIP << 128) | MAX_FEE);
        op.paymasterAndData =
            _signPmSender(address(a), uint48(block.timestamp + 120), uint48(block.timestamp - 10), rate, maxTok);
        op = _signAcctPk(op, ownerPks[idx]);
    }

    function test_F01_accountRotation_cannotConsumeDepositWithoutPaying() public {
        uint256 dep0 = pm.getDeposit();
        uint256 capital = 1_000 * 10 ** dec;
        uint256 maxTok = pm.tokenCost(_maxCost(), rate);

        // PoC attempt without standing allowance: same-batch approve must not authorize payment.
        EpOp[] memory one = new EpOp[](1);
        one[0] = _drainOp(0, attacker, maxTok);
        vm.prank(bundler, bundler);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(DisciplePaymaster.InsufficientUsdgAllowance.selector, 0, maxTok)
            )
        );
        ep.handleOps(one, payable(bundler));

        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(usdg.balanceOf(address(accts[0])), capital);
        assertEq(pm.getDeposit(), dep0);
        assertEq(pm.owedOf(address(accts[0])), 0);

        // With a standing allowance, precharge collects before the drain; unpaid gas is impossible.
        // The PoC transfer(full pre-op balance) reverts after precharge (balance now capital - maxTok), but
        // postOp still settles from the precharge — treasury is paid and no debt is opened.
        vm.prank(address(accts[0]));
        usdg.approve(address(pm), type(uint256).max);
        one[0] = _drainOp(0, attacker, maxTok);
        vm.prank(bundler, bundler);
        ep.handleOps(one, payable(bundler));

        uint256 charged = usdg.balanceOf(treasury);
        assertGt(charged, 0, "treasury paid from precharge");
        assertEq(pm.owedOf(address(accts[0])), 0, "no debt");
        assertEq(usdg.balanceOf(attacker), 0, "drain transfer reverted; attacker empty");
        assertEq(usdg.balanceOf(address(accts[0])), capital - charged, "refund restored unused precharge");
        assertLt(pm.getDeposit(), dep0);

        // Second disposable account cannot free-ride on the same capital without its own standing allowance.
        uint256 left = usdg.balanceOf(address(accts[0]));
        vm.prank(address(accts[0]));
        usdg.transfer(address(accts[1]), left);
        one[0] = _drainOp(1, attacker, maxTok);
        vm.prank(bundler, bundler);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(DisciplePaymaster.InsufficientUsdgAllowance.selector, 0, maxTok)
            )
        );
        ep.handleOps(one, payable(bundler));
        assertEq(usdg.balanceOf(attacker), 0);
    }

    /// @dev Each arbitrary owner call revokes allowance and successfully drains all AVAILABLE USDG to the next
    ///      identity. Payment was already removed, so every disposable account still pays its actual gas.
    function test_F01_rotationWithStandingAllowance_revokeAndDrain_stillFullyPaid() public {
        uint256 depositBefore = pm.getDeposit();
        uint256 totalCharged;
        uint256 totalGasCost;
        uint256 maxTok = pm.tokenCost(_maxCost(), rate);
        for (uint256 i; i < N; ++i) {
            address a = address(accts[i]);
            vm.prank(a);
            usdg.approve(address(pm), type(uint256).max);
            address next = i + 1 < N ? address(accts[i + 1]) : attacker;
            EpOp memory op = _drainOp(i, next, maxTok);
            MiniAccount.Call[] memory calls = new MiniAccount.Call[](2);
            calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), 0)));
            calls[1] =
                MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.transfer, (next, usdg.balanceOf(a) - maxTok)));
            op.callData = abi.encodeCall(MiniAccount.executeBatch, (calls));
            op = _signAcctPk(op, ownerPks[i]);
            EpOp[] memory one = new EpOp[](1);
            one[0] = op;
            vm.recordLogs();
            vm.prank(bundler, bundler);
            ep.handleOps(one, payable(bundler));
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bool success;
            uint256 gasCost;
            uint256 charged;
            for (uint256 j; j < logs.length; ++j) {
                if (logs[j].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                    (, success, gasCost,) = abi.decode(logs[j].data, (uint256, bool, uint256, uint256));
                } else if (logs[j].topics[0] == DisciplePaymaster.UserOperationCharged.selector) {
                    (charged,,) = abi.decode(logs[j].data, (uint256, uint256, uint256));
                }
            }
            assertTrue(success, "remaining balance drain succeeds");
            assertGe(charged, pm.tokenCost(gasCost, rate), "no unpaid gas per disposable account");
            assertEq(usdg.allowance(a, address(pm)), 0, "revocation cannot undo precharge");
            assertEq(usdg.balanceOf(a), maxTok - charged, "unused precharge refunded to sender");
            assertEq(pm.reservedOf(a), 0);
            totalCharged += charged;
            totalGasCost += gasCost;
        }
        assertEq(usdg.balanceOf(treasury), totalCharged);
        assertGe(totalCharged, pm.tokenCost(totalGasCost, rate));
        assertEq(pm.getDeposit(), depositBefore - totalGasCost);
        assertEq(usdg.balanceOf(address(pm)), 0, "all collateral settled");
        assertEq(pm.exposure(), 0);
    }

    function test_F01_globalExposureLimit_cannotBeBypassedByRotatingAccounts() public {
        uint256 maxTok = pm.tokenCost(_maxCost(), rate);
        vm.prank(owner);
        pm.setExposureLimit(maxTok);
        usdg.mint(address(accts[1]), 1_000 * 10 ** dec);
        for (uint256 i; i < 2; ++i) {
            vm.prank(address(accts[i]));
            usdg.approve(address(pm), type(uint256).max);
        }
        PmOp memory op0 = abi.decode(abi.encode(_drainOp(0, attacker, maxTok)), (PmOp));
        PmOp memory op1 = abi.decode(abi.encode(_drainOp(1, attacker, maxTok)), (PmOp));
        vm.prank(address(ep));
        (bytes memory context,) = pm.validatePaymasterUserOp(op0, keccak256("op0"), _maxCost());
        assertEq(pm.exposure(), maxTok);
        assertEq(usdg.balanceOf(address(pm)), maxTok, "pending exposure is secured");
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(DisciplePaymaster.ExposureLimitExceeded.selector, 2 * maxTok, maxTok));
        pm.validatePaymasterUserOp(op1, keccak256("op1"), _maxCost());
        // Pause must not prevent settlement of already-prepaid operations.
        vm.prank(owner);
        pm.setPaused(true);
        vm.prank(address(ep));
        pm.postOp(PostOpMode.opReverted, context, 100_000 * TIP, TIP);
        assertEq(pm.exposure(), 0);
        assertEq(usdg.balanceOf(address(pm)), 0);
        vm.prank(owner);
        pm.setPaused(false);
        vm.prank(address(ep));
        pm.validatePaymasterUserOp(op1, keccak256("op1"), _maxCost());
        assertEq(pm.exposure(), maxTok);
    }

    function test_F01_pauseStopsValidation() public {
        uint256 maxTok = _maxTok();
        vm.prank(owner);
        pm.setPaused(true);
        EpOp memory op = _full(_approveThen(maxTok, _transferCall(attacker, 1)), rate, maxTok);
        vm.expectRevert();
        _send(op);
        vm.prank(owner);
        pm.setPaused(false);
        (bool ok,,) = _sendRecord(_full(_approveThen(maxTok, _transferCall(attacker, 1)), rate, maxTok));
        assertTrue(ok);
    }
}


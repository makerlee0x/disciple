// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {PaymasterTestBase, MiniAccount} from "./PaymasterTestBase.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice F-01: independent secured settlement for same-sender bundles, successes and reverts.
contract PaymasterSettlementTest is PaymasterTestBase {

    address sink = makeAddr("sink");
    uint48 until;
    uint48 afterTs;
    uint256 c; // one standard gas cap (tokenCost of the op's maxCost)

    struct Tally {
        uint256 charged; // Σ UserOperationCharged.gasCostToken
        uint256 repaid; // Σ UserOperationCharged.debtRepaid
        uint256 debtGas; // Σ DebtRecorded.amount
        uint256 gasWei; // Σ actualGasCost
        uint256 okOps;
    }

    function setUp() public {
        _setUp(18);
        until = uint48(block.timestamp + 600);
        afterTs = uint48(block.timestamp - 10);
        c = pm.tokenCost(_maxCost(), rate);
    }

    function _allowance(uint256 m) internal view returns (bytes memory) {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(pm.getHash(address(acct), until, afterTs, rate, m));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(signerPk, h);
        return
            abi.encodePacked(
                address(pm), uint128(PM_VERIF_GAS), uint128(PM_POSTOP_GAS), until, afterTs, rate, m, rr, s, v
            );
    }

    /// @dev paid: [approve(m), transfer 1 to sink]; unpaid: [approve(m), revert] (the approve reverts with the batch).
    function _bundle(uint256[] memory ms, bool[] memory paid) internal returns (EpOp[] memory ops) {
        ops = new EpOp[](ms.length);
        uint256 n0 = ep.getNonce(address(acct), 0);
        for (uint256 i; i < ms.length; ++i) {
            MiniAccount.Call memory next =
                paid[i] ? _transferCall(sink, 1) : MiniAccount.Call(address(rev), 0, abi.encodeWithSignature("fail()"));
            EpOp memory op = _op(_approveThen(ms[i], next));
            op.nonce = n0 + i;
            op.paymasterAndData = _allowance(ms[i]);
            ops[i] = _signAcct(op);
        }
    }

    function _run(EpOp[] memory ops) internal returns (Tally memory t) {
        vm.recordLogs();
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IEntryPoint.UserOperationEvent.selector) {
                (, bool ok, uint256 g,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                t.gasWei += g;
                if (ok) t.okOps++;
            } else if (t0 == DisciplePaymaster.UserOperationCharged.selector) {
                (uint256 g, uint256 r,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                t.charged += g;
                t.repaid += r;
            }
        }
    }

    function _assertSettled() internal view {
        assertEq(pm.reservedOf(address(acct)), 0, "no open reservation");
        assertEq(pm.exposure(), 0, "global exposure released");
    }

    function _one(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _f1(bool a) internal pure returns (bool[] memory x) {
        x = new bool[](1);
        x[0] = a;
    }

    function _arr(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        (x[0], x[1]) = (a, b);
    }

    function _arr(uint256 a, uint256 b, uint256 d) internal pure returns (uint256[] memory x) {
        x = new uint256[](3);
        (x[0], x[1], x[2]) = (a, b, d);
    }

    function _flags(bool a, bool b) internal pure returns (bool[] memory x) {
        x = new bool[](2);
        (x[0], x[1]) = (a, b);
    }

    function _flags(bool a, bool b, bool d) internal pure returns (bool[] memory x) {
        x = new bool[](3);
        (x[0], x[1], x[2]) = (a, b, d);
    }

    // ───────── same bundle, both / all paid: charged once, exactly own gas ─────────

    function test_sameBundle_twoPaid_chargedOnce() public {
        uint256 bal0 = usdg.balanceOf(address(acct));
        Tally memory t = _run(_bundle(_arr(c, 2 * c), _flags(true, true)));
        assertEq(t.okOps, 2);
        uint256 paidUsdg = bal0 - usdg.balanceOf(address(acct)) - 2; // minus the two 1-wei transfers to sink
        assertEq(paidUsdg, t.charged, "user paid exactly the gas charged");
        assertEq(usdg.balanceOf(treasury), t.charged);
        assertEq(t.repaid, 0, "no phantom debt collected");
        assertLe(t.charged, pm.tokenCost(t.gasWei * 2, rate), "gas only (incl. postOp + penalty slack), no extra cap");
        assertLt(t.charged, c, "far below one cap (pre-fix: overcharged by M1)");
        assertEq(pm.owedOf(address(acct)), 0);
        _assertSettled();
    }

    function test_sameBundle_threePaid_escalating_chargedOnce() public {
        uint256 bal0 = usdg.balanceOf(address(acct));
        Tally memory t = _run(_bundle(_arr(c, 2 * c, 3 * c), _flags(true, true, true)));
        assertEq(t.okOps, 3);
        assertEq(bal0 - usdg.balanceOf(address(acct)) - 3, t.charged, "pre-fix: overcharged by M1 + M2");
        assertEq(t.repaid, 0);
        assertLt(t.charged, c);
        assertEq(pm.owedOf(address(acct)), 0);
        _assertSettled();
    }

    // ───────── same bundle, all unpaid: F-01 precharge still pays treasury (no unpaid gas debt) ─────────

    function test_sameBundle_threeUnpaid_prechargePays() public {
        Tally memory t = _run(_bundle(_arr(c, 2 * c, 3 * c), _flags(false, false, false)));
        assertEq(t.okOps, 0, "all reverted");
        assertGt(usdg.balanceOf(treasury), 0, "precharge settled gas");
        assertEq(usdg.balanceOf(treasury), t.charged);
        assertEq(pm.owedOf(address(acct)), 0, "no unpaid debt");
        assertEq(t.debtGas, 0);
        _assertSettled();
    }

    // ───────── mixed: reverted ops still prepay; paid op does not inherit unpaid gas debt ─────────

    function test_sameBundle_unpaidThenPaid_prechargeEach() public {
        uint256 bal0 = usdg.balanceOf(address(acct));
        Tally memory t = _run(_bundle(_arr(c, 2 * c), _flags(false, true)));
        assertEq(t.okOps, 1);
        assertEq(t.debtGas, 0);
        assertEq(t.repaid, 0);
        assertEq(bal0 - usdg.balanceOf(address(acct)) - 1, t.charged);
        assertEq(usdg.balanceOf(treasury), t.charged);
        assertEq(pm.owedOf(address(acct)), 0);
        _assertSettled();
    }

    function test_sameBundle_paidThenUnpaid() public {
        Tally memory t = _run(_bundle(_arr(c, 2 * c), _flags(true, false)));
        assertEq(t.okOps, 1);
        assertEq(pm.owedOf(address(acct)), 0);
        assertEq(usdg.balanceOf(treasury), t.charged + t.repaid);
        assertEq(t.debtGas, 0);
        _assertSettled();
    }

    /// @dev Sequential ops (one per handleOps, the DISCIPLE relay path) still settle with no leftovers.
    function test_sequential_noLeftovers() public {
        for (uint256 i; i < 3; ++i) {
            Tally memory t = _run(_bundle(_one(c), _f1(true)));
            assertEq(t.okOps, 1);
            assertEq(t.repaid, 0);
        }
        assertEq(pm.owedOf(address(acct)), 0);
        _assertSettled();
    }
}

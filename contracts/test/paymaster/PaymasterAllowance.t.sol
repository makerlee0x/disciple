// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymasterTestBase, MiniAccount} from "./PaymasterTestBase.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Per-sender allowance: one signature (sender, chainId, paymaster, validUntil, validAfter, rate, maxTokenCost)
///         reused by many ops, with every per-op check still on-chain and exposure ≤ maxTokenCost per sender.
contract PaymasterAllowanceTest is PaymasterTestBase {
    address sink = makeAddr("sink");
    uint48 until;
    uint48 afterTs;
    uint256 maxTok;

    function setUp() public {
        _setUp(18);
        until = uint48(block.timestamp + 600);
        afterTs = uint48(block.timestamp - 10);
        maxTok = _maxTok();
    }

    // ───────── helpers ─────────

    function _allowance(address sender, uint48 u, uint48 a, uint256 r, uint256 m, uint256 pk, uint128 postOpGas)
        internal
        view
        returns (bytes memory)
    {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(pm.getHash(sender, u, a, r, m));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(address(pm), uint128(PM_VERIF_GAS), postOpGas, u, a, r, m, rr, s, v);
    }

    function _std() internal view returns (bytes memory) {
        return _allowance(address(acct), until, afterTs, rate, maxTok, signerPk, uint128(PM_POSTOP_GAS));
    }

    function _withPm(bytes memory callData, bytes memory pmd) internal returns (EpOp memory op) {
        op = _op(callData);
        op.paymasterAndData = pmd;
        op = _signAcct(op);
    }

    function _trade(uint256 amt) internal view returns (bytes memory) {
        return _approveThen(maxTok, _transferCall(sink, amt));
    }

    function _maxCostTooLow(uint256 idx, uint256 m, uint256 required) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            IEntryPoint.FailedOpWithRevert.selector,
            idx,
            "AA33 reverted",
            abi.encodeWithSelector(DisciplePaymaster.MaxCostTooLow.selector, m, required)
        );
    }

    // ───────── replay within the allowance ─────────

    function test_replayWithinAllowance_ok() public {
        bytes memory pmd = _std();
        uint256 dep0 = pm.getDeposit();
        uint256 charged;
        uint256 gasSum;
        for (uint256 i = 1; i <= 4; ++i) {
            (bool ok, uint256 g, uint256 c) = _sendRecord(_withPm(_trade(i), pmd));
            assertTrue(ok, "op ok");
            charged += c;
            gasSum += g;
            vm.warp(block.timestamp + 30); // still inside [validAfter, validUntil]
        }
        assertEq(usdg.balanceOf(sink), 1 + 2 + 3 + 4);
        assertEq(usdg.balanceOf(treasury), charged, "every op billed");
        assertEq(pm.getDeposit(), dep0 - gasSum);
        assertGe(charged, pm.tokenCost(gasSum, rate), "fully recovered, nothing sponsored");
        assertEq(pm.debtOf(address(acct)), 0);
        assertEq(pm.reservedOf(address(acct)), 0, "postOp clears the reservation");
    }

    // ───────── exceeding maxTokenCost reverts ─────────

    function test_revert_opCostAboveMaxTokenCost() public {
        bytes memory pmd = _std();
        EpOp memory op = _op(_trade(1));
        op.paymasterAndData = pmd;
        op.gasFees = bytes32((TIP << 128) | (MAX_FEE * 2)); // worst case now 2x what the allowance covers
        op = _signAcct(op);
        uint256 required = pm.tokenCost(_maxCost() * 2, rate);
        vm.expectRevert(_maxCostTooLow(0, maxTok, required));
        _send(op);
    }

    function test_revert_maxTokenCostAboveCap() public {
        uint256 big = pm.maxCostCap() + 1;
        bytes memory pmd = _allowance(address(acct), until, afterTs, rate, big, signerPk, uint128(PM_POSTOP_GAS));
        EpOp memory op = _withPm(_approveThen(big, _transferCall(sink, 1)), pmd);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(DisciplePaymaster.MaxCostAboveCap.selector, big, pm.maxCostCap())
            )
        );
        _send(op);
    }

    /// @dev Two ops of one sender in ONE bundle: op 0's reservation is still open when op 1 validates, so it counts as
    ///      debt and op 1 can't fit inside the same maxTokenCost ⇒ the bundle is rejected.
    function test_revert_sameSenderTwiceInOneBundle() public {
        bytes memory pmd = _std();
        EpOp[] memory ops = new EpOp[](2);
        ops[0] = _withPm(_trade(1), pmd);
        EpOp memory o2 = _op(_trade(2));
        o2.nonce = ops[0].nonce + 1;
        o2.paymasterAndData = pmd;
        ops[1] = _signAcct(o2);
        uint256 required = pm.tokenCost(_maxCost(), rate) + maxTok;
        vm.expectRevert(_maxCostTooLow(1, maxTok, required));
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
    }

    // ───────── expiry ─────────

    function test_revert_expiredAllowance() public {
        bytes memory pmd = _std();
        _send(_withPm(_trade(1), pmd)); // fine while valid
        vm.warp(uint256(until) + 1);
        EpOp memory op = _withPm(_trade(1), pmd);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due"));
        _send(op);
    }

    function test_revert_notYetValidAllowance() public {
        bytes memory pmd = _allowance(
            address(acct), until, uint48(block.timestamp + 5), rate, maxTok, signerPk, uint128(PM_POSTOP_GAS)
        );
        EpOp memory op = _withPm(_trade(1), pmd);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due"));
        _send(op);
    }

    // ───────── wrong sender / chain / paymaster ─────────

    function test_revert_wrongSender() public {
        MiniAccount other = new MiniAccount(address(ep), user);
        usdg.mint(address(other), 1_000 * 10 ** dec);
        bytes memory pmd = _std(); // signed for acct
        EpOp memory op = _op(_trade(1));
        op.sender = address(other);
        op.nonce = ep.getNonce(address(other), 0);
        op.paymasterAndData = pmd;
        op = _signAcct(op);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _send(op);
    }

    function test_revert_wrongChain() public {
        bytes memory pmd = _std();
        vm.chainId(1);
        EpOp memory op = _withPm(_trade(1), pmd);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _send(op);
    }

    function test_revert_wrongSigner() public {
        bytes memory pmd = _allowance(address(acct), until, afterTs, rate, maxTok, 0xBAD, uint128(PM_POSTOP_GAS));
        EpOp memory op = _withPm(_trade(1), pmd);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _send(op);
    }

    // ───────── rate ─────────

    function test_revert_rateTampered() public {
        bytes memory pmd = _std();
        uint256 half = rate / 2;
        assembly {
            mstore(add(add(pmd, 32), 64), half) // rate word at offset 64
        }
        EpOp memory op = _withPm(_trade(1), pmd);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _send(op);
    }

    function test_revert_signedRateOutOfBounds() public {
        uint256 hi = pm.maxRate() + 1;
        bytes memory pmd = _allowance(address(acct), until, afterTs, hi, maxTok, signerPk, uint128(PM_POSTOP_GAS));
        EpOp memory op = _withPm(_trade(1), pmd);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(DisciplePaymaster.RateOutOfBounds.selector, hi)
            )
        );
        _send(op);
    }

    function test_chargedAtSignedRate() public {
        (bool ok, uint256 g, uint256 c) = _sendRecord(_withPm(_trade(1), _std()));
        assertTrue(ok);
        assertGe(c, pm.tokenCost(g, rate));
        assertApproxEqRel(c, pm.tokenCost(g, rate), 0.03e18);
    }

    // ───────── griefing / drain ─────────

    function test_revert_postOpGasStarved() public {
        bytes memory pmd = _allowance(address(acct), until, afterTs, rate, maxTok, signerPk, uint128(10_000));
        EpOp memory op = _withPm(_trade(1), pmd);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(
                    DisciplePaymaster.PostOpGasLimitTooLow.selector, 10_000, pm.MIN_PM_POST_OP_GAS_LIMIT()
                )
            )
        );
        _send(op);
    }

    /// @dev Sender drains its USDG inside the op: the pull fails, debt is recorded and stays ≤ maxTokenCost; the same
    ///      allowance can't be reused until a fresh one covers the debt (bound: maxTokenCost per sender).
    function test_drain_boundedByMaxTokenCost() public {
        bytes memory pmd = _std();
        uint256 all = usdg.balanceOf(address(acct));
        (bool ok,,) = _sendRecord(_withPm(_approveThen(maxTok, _transferCall(sink, all)), pmd));
        assertTrue(ok);
        uint256 debt = pm.debtOf(address(acct));
        assertGt(debt, 0, "pull failed -> debt");
        assertLe(debt, maxTok, "exposure <= maxTokenCost");
        assertEq(pm.reservedOf(address(acct)), 0);

        usdg.mint(address(acct), 1_000 * 10 ** dec); // even with fresh funds the old allowance is now too small
        EpOp memory op = _withPm(_trade(1), pmd);
        vm.expectRevert(_maxCostTooLow(0, maxTok, pm.tokenCost(_maxCost(), rate) + debt));
        _send(op);

        // a fresh allowance that includes the debt collects it
        uint256 m2 = maxTok + debt;
        bytes memory pmd2 = _allowance(address(acct), until, afterTs, rate, m2, signerPk, uint128(PM_POSTOP_GAS));
        (bool ok2,,) = _sendRecord(_withPm(_approveThen(m2, _transferCall(sink, 1)), pmd2));
        assertTrue(ok2);
        assertEq(pm.debtOf(address(acct)), 0, "debt collected");
    }

    function test_forgiveDebt_clearsReservation() public {
        vm.prank(owner);
        pm.forgiveDebt(address(acct));
        assertEq(pm.reservedOf(address(acct)), 0);
    }

    /// @dev Byte parity with web/lib/aa/paymaster.ts paymasterAllowanceHash (same vector in scripts/test-paymaster.mts).
    function test_hashVector_matchesWeb() public {
        assertEq(pm.ALLOWANCE_TYPEHASH(), 0x8faf4adbeca2994e3e15d84d2784553f8bde4856d7a67536eb2e03e4a702e8ae);
        address at = 0x1111111111111111111111111111111111111111;
        vm.etch(at, address(pm).code);
        vm.chainId(46630);
        bytes32 h = DisciplePaymaster(at).getHash(
            0x3333333333333333333333333333333333333333, 1_790_000_600, 1_789_999_970, 3000e18, 123456789012345678
        );
        assertEq(h, 0x2712d08f58bdadb5f8d8c71b6d3b07446639b9ae4a25af59e4fd25107429c065);
    }
}

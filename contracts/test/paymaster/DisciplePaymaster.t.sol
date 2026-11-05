// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymasterTestBase, MiniAccount, MockUSDG, Reverter} from "./PaymasterTestBase.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {PostOpMode} from "../../src/paymaster/IPaymasterV07.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice DisciplePaymaster on a local EntryPoint v0.7 — 18-decimal USDG (RH testnet).
contract DisciplePaymasterTest is PaymasterTestBase {
    address sink = makeAddr("sink");

    function setUp() public virtual {
        _setUp(18);
    }

    // ───────── happy path: user has NO ETH, pays actual gas in USDG ─────────

    function test_userPaysActualGasInUsdg_noEth() public {
        assertEq(address(acct).balance, 0);
        assertEq(ep.balanceOf(address(acct)), 0);
        uint256 maxTok = _maxTok();
        uint256 dep0 = pm.getDeposit();
        uint256 bal0 = usdg.balanceOf(address(acct));
        (bool ok, uint256 actualGasCost, uint256 charged) =
            _sendRecord(_full(_approveThen(maxTok, _transferCall(sink, 5 * 10 ** dec)), rate, maxTok));
        assertTrue(ok, "op ok");
        assertEq(usdg.balanceOf(sink), 5 * 10 ** dec);
        assertEq(usdg.balanceOf(treasury), charged, "treasury got the charge");
        assertEq(usdg.balanceOf(address(acct)), bal0 - 5 * 10 ** dec - charged);
        assertEq(address(acct).balance, 0, "still no ETH");
        assertEq(pm.getDeposit(), dep0 - actualGasCost, "paymaster deposit fronted the ETH");
        // billed on ACTUAL gas: within 15% of the EntryPoint's real charge, and far below the signed max
        uint256 actualTok = pm.tokenCost(actualGasCost, rate);
        assertApproxEqRel(charged, actualTok, 0.03e18, "charge ~ actual gas");
        assertGe(charged, actualTok, "never below the real cost (no sponsorship)");
        assertLt(charged, maxTok / 2, "not charged the max");
        assertEq(pm.owedOf(address(acct)), 0);
    }

    function test_executeUserOpPrefix_MAv2Shape() public {
        uint256 maxTok = _maxTok();
        bytes memory inner = _approveThen(maxTok, _transferCall(sink, 1));
        bytes memory cd = abi.encodePacked(bytes4(0x8dd7712f), inner);
        (bool ok,, uint256 charged) = _sendRecord(_full(cd, rate, maxTok));
        assertTrue(ok);
        assertGt(charged, 0);
        assertEq(usdg.balanceOf(treasury), charged);
    }

    function test_existingAllowance_withoutGasAccountingMarker_rejected() public {
        uint256 maxTok = _maxTok();
        vm.prank(address(acct));
        usdg.approve(address(pm), maxTok);
        bytes memory cd =
            abi.encodeCall(MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.transfer, (sink, 7))));
        EpOp memory op = _full(cd, rate, maxTok);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.GasApprovalMissing.selector)));
        _send(op);
        assertEq(usdg.balanceOf(sink), 0);
        assertEq(pm.exposure(), 0);
    }

    function test_singleExecuteApprove_counts() public {
        uint256 maxTok = _maxTok();
        bytes memory cd = abi.encodeCall(
            MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), maxTok)))
        );
        (bool ok,, uint256 charged) = _sendRecord(_full(cd, rate, maxTok));
        assertTrue(ok);
        assertGt(charged, 0);
    }

    // ───────── validation refusals ─────────

    function test_revert_badSigner() public {
        uint256 maxTok = _maxTok();
        EpOp memory op = _op(_approveThen(maxTok, _transferCall(sink, 1)));
        op = _signPm(op, uint48(block.timestamp + 60), uint48(block.timestamp - 1), rate, maxTok, 0xBAD);
        op = _signAcct(op);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _send(op);
    }

    function test_revert_tamperedRate() public {
        uint256 maxTok = _maxTok();
        EpOp memory op = _op(_approveThen(maxTok, _transferCall(sink, 1)));
        op = _signPm(op, uint48(block.timestamp + 60), uint48(block.timestamp - 1), rate, maxTok, signerPk);
        // user rewrites the rate to half after signing
        bytes memory p = op.paymasterAndData;
        uint256 half = rate / 2;
        assembly {
            mstore(add(add(p, 32), 64), half)
        }
        op = _signAcct(op);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _send(op);
    }

    /// @dev The allowance binds the sender, not the op: a different callData under the same signature is fine as
    ///      long as every on-chain per-op check still holds (here the approve amount must still equal maxTokenCost).
    function test_allowance_notBoundToCallData() public {
        uint256 maxTok = _maxTok();
        EpOp memory op = _op(_approveThen(maxTok, _transferCall(sink, 1)));
        op = _signPm(op, uint48(block.timestamp + 60), uint48(block.timestamp - 1), rate, maxTok, signerPk);
        op.callData = _approveThen(maxTok, _transferCall(sink, 2));
        op = _signAcct(op);
        _send(op);
        assertEq(usdg.balanceOf(sink), 2);
    }

    function test_revert_expiredQuote() public {
        uint256 maxTok = _maxTok();
        EpOp memory op = _op(_approveThen(maxTok, _transferCall(sink, 1)));
        op = _signPm(op, uint48(block.timestamp - 1), uint48(block.timestamp - 60), rate, maxTok, signerPk);
        op = _signAcct(op);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due"));
        _send(op);
    }

    function test_revert_notYetValid() public {
        uint256 maxTok = _maxTok();
        EpOp memory op = _op(_approveThen(maxTok, _transferCall(sink, 1)));
        op = _signPm(op, uint48(block.timestamp + 600), uint48(block.timestamp + 60), rate, maxTok, signerPk);
        op = _signAcct(op);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due"));
        _send(op);
    }

    function test_revert_quoteWindowTooLong() public {
        uint256 maxTok = _maxTok();
        EpOp memory op = _op(_approveThen(maxTok, _transferCall(sink, 1)));
        op = _signPm(op, uint48(block.timestamp + 2 hours), uint48(block.timestamp - 1), rate, maxTok, signerPk);
        op = _signAcct(op);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.QuoteWindowInvalid.selector)));
        _send(op);
    }

    function test_revert_rateAboveCap() public {
        uint256 r = rate * 11;
        uint256 maxTok = pm.tokenCost(_maxCost(), r);
        vm.prank(owner);
        pm.setBounds(rate / 10, rate * 10, 100 * 10 ** dec);
        EpOp memory op_1 = _full(_approveThen(maxTok, _transferCall(sink, 1)), r, maxTok);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.RateOutOfBounds.selector, r)));
        _send(op_1);
    }

    function test_revert_rateBelowFloor() public {
        uint256 r = rate / 11;
        uint256 maxTok = pm.tokenCost(_maxCost(), r);
        EpOp memory op_2 = _full(_approveThen(maxTok, _transferCall(sink, 1)), r, maxTok);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.RateOutOfBounds.selector, r)));
        _send(op_2);
    }

    function test_revert_maxCostAboveCap() public {
        uint256 maxTok = 101 * 10 ** dec;
        EpOp memory op_3 = _full(_approveThen(maxTok, _transferCall(sink, 1)), rate, maxTok);
        vm.expectRevert(
            _aa33(abi.encodeWithSelector(DisciplePaymaster.MaxCostAboveCap.selector, maxTok, 100 * 10 ** dec))
        );
        _send(op_3);
    }

    function test_revert_maxCostBelowWorstCase() public {
        uint256 need = _maxTok();
        uint256 maxTok = need - 1;
        EpOp memory op_4 = _full(_approveThen(maxTok, _transferCall(sink, 1)), rate, maxTok);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.MaxCostTooLow.selector, maxTok, need)));
        _send(op_4);
    }

    function test_revert_insufficientBalance() public {
        uint256 maxTok = _maxTok();
        uint256 bal = usdg.balanceOf(address(acct));
        vm.prank(address(acct));
        usdg.transfer(sink, bal - (maxTok - 1));
        EpOp memory op_5 = _full(_approveThen(maxTok, _transferCall(sink, 1)), rate, maxTok);
        vm.expectRevert(
            _aa33(abi.encodeWithSelector(DisciplePaymaster.InsufficientUsdgBalance.selector, maxTok - 1, maxTok))
        );
        _send(op_5);
    }

    function test_revert_noAllowanceNoApprove() public {
        uint256 maxTok = _maxTok();
        vm.prank(address(acct));
        usdg.approve(address(pm), 0);
        bytes memory cd =
            abi.encodeCall(MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.transfer, (sink, 7))));
        EpOp memory op_6 = _full(cd, rate, maxTok);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.InsufficientUsdgAllowance.selector, 0, maxTok)));
        _send(op_6);
    }

    function test_revert_approveTooSmall() public {
        uint256 maxTok = _maxTok();
        vm.prank(address(acct));
        usdg.approve(address(pm), 0);
        EpOp memory op_7 = _full(_approveThen(maxTok - 1, _transferCall(sink, 1)), rate, maxTok);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.InsufficientUsdgAllowance.selector, 0, maxTok)));
        _send(op_7);
    }

    function test_revert_approveNotFirst() public {
        uint256 maxTok = _maxTok();
        vm.prank(address(acct));
        usdg.approve(address(pm), 0);
        MiniAccount.Call[] memory c = new MiniAccount.Call[](2);
        c[0] = _transferCall(sink, 1);
        c[1] = _approve(maxTok);
        EpOp memory op_8 = _full(_batch(c), rate, maxTok);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.InsufficientUsdgAllowance.selector, 0, maxTok)));
        _send(op_8);
    }

    function test_revert_approveOtherToken() public {
        uint256 maxTok = _maxTok();
        vm.prank(address(acct));
        usdg.approve(address(pm), 0);
        MockUSDG fake = new MockUSDG(dec);
        MiniAccount.Call[] memory c = new MiniAccount.Call[](2);
        c[0] = MiniAccount.Call(address(fake), 0, abi.encodeCall(ERC20.approve, (address(pm), maxTok)));
        c[1] = _transferCall(sink, 1);
        EpOp memory op_9 = _full(_batch(c), rate, maxTok);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.InsufficientUsdgAllowance.selector, 0, maxTok)));
        _send(op_9);
    }

    function test_revert_badLength() public {
        EpOp memory op = _op(_approveThen(1, _transferCall(sink, 1)));
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), uint48(1), uint48(0));
        op = _signAcct(op);
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.PaymasterAndDataLengthInvalid.selector)));
        _send(op);
    }

    function test_onlyEntryPoint() public {
        EpOp memory op;
        vm.expectRevert(DisciplePaymaster.NotEntryPoint.selector);
        (bool s,) = address(pm)
            .call(abi.encodeWithSelector(DisciplePaymaster.validatePaymasterUserOp.selector, op, bytes32(0), 0));
        s;
        vm.expectRevert(DisciplePaymaster.NotEntryPoint.selector);
        pm.postOp(PostOpMode.opSucceeded, "", 0, 0);
    }

    // ───────── AUDIT F-01: precharge settles even when the user call reverts or tries to drain ─────────

    function test_revertedBatch_stillPaysFromPrecharge() public {
        uint256 maxTok = _maxTok();
        uint256 bal0 = usdg.balanceOf(address(acct));
        MiniAccount.Call memory boom = MiniAccount.Call(address(rev), 0, abi.encodeCall(Reverter.fail, ()));
        (bool ok,, uint256 charged) = _sendRecord(_full(_approveThen(maxTok, boom), rate, maxTok));
        assertFalse(ok, "inner reverted");
        assertEq(pm.owedOf(address(acct)), 0, "no debt: precharge settled");
        assertGt(charged, 0);
        assertEq(usdg.balanceOf(treasury), charged);
        assertEq(usdg.balanceOf(address(acct)), bal0 - charged, "unused precharge refunded");
    }

    function test_userDrainsUsdgInBatch_stillPaysFromPrecharge() public {
        uint256 maxTok = _maxTok();
        uint256 bal = usdg.balanceOf(address(acct));
        // transfer(full pre-op bal) reverts after precharge reduced the balance; gas still paid.
        (bool ok,, uint256 charged) = _sendRecord(_full(_approveThen(maxTok, _transferCall(sink, bal)), rate, maxTok));
        assertFalse(ok, "drain transfer reverts after precharge");
        assertEq(pm.owedOf(address(acct)), 0, "no debt");
        assertGt(usdg.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(treasury), charged);
        assertEq(usdg.balanceOf(sink), 0);
    }

    function test_circuitBreakers_ownerOnly() public {
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.setPaused(true);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.setExposureLimit(1);
        vm.prank(owner);
        pm.setPaused(true);
        assertTrue(pm.paused());
        vm.prank(owner);
        pm.setExposureLimit(1);
        assertEq(pm.exposureLimit(), 1);
    }

    function test_exposureLimit_rejectsBeforeTakingTokens_andReleasesAfterPostOp() public {
        uint256 maxTok = _maxTok();
        uint256 balance = usdg.balanceOf(address(acct));
        vm.prank(owner);
        pm.setExposureLimit(maxTok - 1);
        EpOp memory op = _full(_approveThen(maxTok, _transferCall(sink, 1)), rate, maxTok);
        vm.expectRevert(
            _aa33(abi.encodeWithSelector(DisciplePaymaster.ExposureLimitExceeded.selector, maxTok, maxTok - 1))
        );
        _send(op);
        assertEq(usdg.balanceOf(address(acct)), balance);
        assertEq(pm.exposure(), 0);
        vm.prank(owner);
        pm.setExposureLimit(maxTok);
        _send(op);
        assertEq(pm.exposure(), 0);
        assertEq(pm.reservedOf(address(acct)), 0);
    }

    function test_failedPrecharge_rejectsBeforeExecution() public {
        uint256 maxTok = _maxTok();
        EpOp memory op = _full(_approveThen(maxTok, _transferCall(sink, 1)), rate, maxTok);
        vm.mockCall(address(usdg), abi.encodeWithSelector(ERC20.transferFrom.selector), abi.encode(false));
        vm.expectRevert(_aa33(abi.encodeWithSelector(DisciplePaymaster.PrechargeFailed.selector, maxTok)));
        _send(op);
        assertEq(usdg.balanceOf(sink), 0);
        assertEq(pm.exposure(), 0);
    }

    function test_failedSettlementTransfers_createSecuredRecipientCredits() public {
        uint256 maxTok = _maxTok();
        uint256 bal0 = usdg.balanceOf(address(acct));
        bytes memory cd = abi.encodeCall(
            MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), type(uint256).max)))
        );
        vm.mockCall(address(usdg), abi.encodeWithSelector(ERC20.transfer.selector), abi.encode(false));
        (bool ok,, uint256 charged) = _sendRecord(_full(cd, rate, maxTok));
        assertTrue(ok);
        assertGt(charged, 0);
        assertEq(pm.creditOf(treasury), charged);
        assertEq(pm.creditOf(address(acct)), maxTok - charged);
        assertEq(usdg.balanceOf(address(pm)), maxTok, "credits fully collateralized");
        assertEq(pm.exposure(), 0);
        vm.expectRevert(abi.encodeWithSelector(DisciplePaymaster.PrechargeFailed.selector, charged));
        pm.claimCredit(treasury);
        assertEq(pm.creditOf(treasury), charged, "failed claim preserves ownership");
        vm.clearMockedCalls();
        vm.prank(sink); // third parties can retry but cannot redirect a credit
        pm.claimCredit(treasury);
        pm.claimCredit(address(acct));
        pm.claimCredit(treasury); // no double claim
        assertEq(usdg.balanceOf(treasury), charged);
        assertEq(usdg.balanceOf(address(acct)), bal0 - charged);
        assertEq(usdg.balanceOf(address(pm)), 0);
        assertEq(pm.creditOf(treasury), 0);
        assertEq(pm.creditOf(address(acct)), 0);
    }

    // ───────── owner / deposit / stake ─────────

    function test_ownerConfig() public {
        address n = makeAddr("n");
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.setSigner(n);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.setTreasury(n);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.setBounds(1, 2, 3);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.setPostOpGas(1);
        vm.startPrank(owner);
        pm.setSigner(n);
        pm.setTreasury(n);
        pm.setBounds(1, 2, 3);
        pm.setPostOpGas(60_000);
        vm.expectRevert(DisciplePaymaster.ZeroAddress.selector);
        pm.setSigner(address(0));
        vm.expectRevert(DisciplePaymaster.ZeroAddress.selector);
        pm.setTreasury(address(0));
        vm.expectRevert(DisciplePaymaster.InvalidBounds.selector);
        pm.setBounds(0, 2, 3);
        vm.expectRevert(DisciplePaymaster.InvalidBounds.selector);
        pm.setBounds(3, 2, 3);
        vm.expectRevert(DisciplePaymaster.InvalidBounds.selector);
        pm.setBounds(1, 2, 0);
        vm.expectRevert(DisciplePaymaster.InvalidBounds.selector);
        pm.setPostOpGas(200_001);
        vm.stopPrank();
        assertEq(pm.signer(), n);
        assertEq(pm.treasury(), n);
        assertEq(pm.maxRate(), 2);
        assertEq(pm.postOpGas(), 60_000);
    }

    function test_rotatedSigner_oldQuotesFail() public {
        vm.prank(owner);
        pm.setSigner(makeAddr("newSigner"));
        uint256 maxTok = _maxTok();
        EpOp memory op_11 = _full(_approveThen(maxTok, _transferCall(sink, 1)), rate, maxTok);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _send(op_11);
    }

    function test_owned2Step() public {
        address n = makeAddr("newOwner");
        vm.prank(owner);
        pm.transferOwnership(n);
        assertEq(pm.owner(), owner);
        vm.expectRevert(Owned2Step.NotPendingOwner.selector);
        pm.acceptOwnership();
        vm.prank(n);
        pm.acceptOwnership();
        assertEq(pm.owner(), n);
    }

    function test_depositWithdraw() public {
        address payable to = payable(makeAddr("to"));
        uint256 d = pm.getDeposit();
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.withdrawTo(to, 1);
        vm.prank(owner);
        pm.withdrawTo(to, 0.25 ether);
        assertEq(to.balance, 0.25 ether);
        assertEq(pm.getDeposit(), d - 0.25 ether);
    }

    function test_stakeLifecycle() public {
        address payable to = payable(makeAddr("to"));
        vm.deal(owner, 1 ether);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.addStake{value: 0}(1 days);
        vm.startPrank(owner);
        pm.addStake{value: 0.5 ether}(1 days);
        assertEq(ep.getDepositInfo(address(pm)).stake, 0.5 ether);
        pm.unlockStake();
        vm.warp(block.timestamp + 1 days + 1);
        pm.withdrawStake(to);
        vm.stopPrank();
        assertEq(to.balance, 0.5 ether);
    }

    // ───────── pure helpers ─────────

    function testFuzz_tokenCostRoundsUp(uint128 w, uint96 r) public view {
        vm.assume(r > 0);
        uint256 c = pm.tokenCost(w, r);
        assertGe(c * 1e18, uint256(w) * r);
        assertLt(c * 1e18, uint256(w) * r + 1e18);
    }

    function testFuzz_firstCallApproves_neverReverts(bytes calldata junk) public view {
        pm.firstCallApproves(junk, 1);
        pm.firstCallApproves(abi.encodePacked(bytes4(0x8dd7712f), junk), 1);
        pm.firstCallApproves(abi.encodePacked(MiniAccount.executeBatch.selector, junk), 1);
        pm.firstCallApproves(abi.encodePacked(MiniAccount.execute.selector, junk), 1);
    }

    function test_firstCallApproves_shapes() public view {
        bytes memory b = _approveThen(10, _transferCall(sink, 1));
        assertTrue(pm.firstCallApproves(b, 10));
        assertFalse(pm.firstCallApproves(b, 11));
        assertTrue(pm.firstCallApproves(abi.encodePacked(bytes4(0x8dd7712f), b), 10));
        MiniAccount.Call[] memory none = new MiniAccount.Call[](0);
        assertFalse(pm.firstCallApproves(_batch(none), 0));
    }
}

/// @notice Same suite against 6-decimal USDG (mainnet decimals): every amount is raw-unit / decimals-aware.
contract DisciplePaymaster6DecTest is DisciplePaymasterTest {
    function setUp() public override {
        _setUp(6);
    }
}

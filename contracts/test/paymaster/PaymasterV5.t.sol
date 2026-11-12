// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EntryPoint} from "../vendor/aa-v07/core/EntryPoint.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {PackedUserOperation as PmOp, PostOpMode} from "../../src/paymaster/IPaymasterV07.sol";
import {DisciplePaymasterV5 as PM} from "../../src/paymaster/DisciplePaymasterV5.sol";
import {MockUSDG, MiniAccount, Reverter} from "./PaymasterTestBase.sol";

/// @notice Touching balance/allowance from the paymaster reverts. transferFrom still works, so a passing
///         validation proves the paymaster did not read token state before execution.
contract GuardedUSDG is MockUSDG {
    address public guarded;
    bool public guardReads;

    constructor(uint8 d) MockUSDG(d) {}

    function setGuarded(address g) external {
        guarded = g;
    }

    function setGuardReads(bool on) external {
        guardReads = on;
    }

    function balanceOf(address a) public view override returns (uint256) {
        if (guardReads && msg.sender == guarded) revert("paymaster read balance");
        return super.balanceOf(a);
    }

    function allowance(address a, address b) public view override returns (uint256) {
        if (guardReads && msg.sender == guarded) revert("paymaster read allowance");
        return super.allowance(a, b);
    }
}

contract PaymasterV5Test is Test {
    EntryPoint ep;
    GuardedUSDG usdg;
    PM pm;
    MiniAccount acct;
    Reverter rev;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address bundler = makeAddr("bundler");
    uint256 constant SIGNER_PK = 0xA11CE;
    address signer;
    uint256 constant USER_PK = 0xB0B;
    address user;

    uint256 constant CALL_GAS = 200_000;
    uint256 constant VERIF_GAS = 120_000;
    uint256 constant PVG = 50_000;
    uint256 constant PM_VERIF = 180_000;
    uint256 constant PM_POST = 160_000;
    uint256 constant MAX_FEE = 1 gwei;
    uint256 constant TIP = 1 gwei;
    uint256 constant RATE = 2_300_000_000; // 2300 USDG per ETH, 6 decimals
    uint256 constant TRADE_CAP = 7_068_712;
    uint256 constant LAUNCH_CAP = 21_840_770;
    bytes4 internal constant DEPOSIT_SEL = bytes4(keccak256("deposit(address,uint256)"));

    function _asPm(EpOp memory op) internal pure returns (PmOp memory out) {
        out = abi.decode(abi.encode(op), (PmOp));
    }

    function setUp() public {
        signer = vm.addr(SIGNER_PK);
        user = vm.addr(USER_PK);
        ep = new EntryPoint();
        usdg = new GuardedUSDG(6);
        pm = new PM(address(ep), address(usdg), owner, signer, treasury, RATE / 10, RATE * 10, TRADE_CAP, 40_000);
        vm.prank(owner);
        pm.setLaunchGasLimit(LAUNCH_CAP);
        usdg.setGuarded(address(pm));
        acct = new MiniAccount(address(ep), user);
        rev = new Reverter();
        pm.deposit{value: 5 ether}();
        vm.prank(owner);
        pm.setPostOpGas(150_000);
        usdg.mint(address(acct), 1_000_000_000); // 1000 USDG
        vm.prank(address(acct));
        usdg.approve(address(pm), type(uint256).max);
        vm.fee(0);
        vm.warp(1_790_000_000);
    }

    function _gasUnits() internal pure returns (uint256) {
        return CALL_GAS + VERIF_GAS + PVG + PM_VERIF + PM_POST;
    }

    function _maxCost() internal pure returns (uint256) {
        return _gasUnits() * MAX_FEE;
    }

    function _need() internal view returns (uint256) {
        return pm.tokenCost(_maxCost(), RATE);
    }

    function _fund(uint256 amount) internal {
        vm.prank(address(acct));
        pm.deposit(address(acct), amount);
    }

    function _batch(MiniAccount.Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(MiniAccount.executeBatch, (calls));
    }

    function _trade() internal view returns (bytes memory) {
        return abi.encodeCall(MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.transfer, (address(acct), 0))));
    }

    function _op(bytes memory callData) internal view returns (EpOp memory op) {
        op.sender = address(acct);
        op.nonce = ep.getNonce(address(acct), 0);
        op.callData = callData;
        op.accountGasLimits = bytes32((VERIF_GAS << 128) | CALL_GAS);
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((TIP << 128) | MAX_FEE);
    }

    function _sign(EpOp memory op, uint256 maxTok, bytes32 domain) internal view returns (EpOp memory) {
        bytes memory prefix = abi.encodePacked(address(pm), uint128(PM_VERIF), uint128(PM_POST));
        uint48 until = uint48(block.timestamp + 120);
        uint48 afterTs = uint48(block.timestamp - 10);
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, RATE, maxTok, new bytes(65));
        bytes32 h = domain == pm.LAUNCH_QUOTE_TYPEHASH()
            ? pm.getLaunchOpHash(_asPm(op), until, afterTs, RATE, maxTok)
            : domain == pm.OP_QUOTE_TYPEHASH()
                ? pm.getOpHash(_asPm(op), until, afterTs, RATE, maxTok)
                : pm.getHash(op.sender, until, afterTs, RATE, maxTok);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, RATE, maxTok, r, s, v);
        bytes32 uh = ep.getUserOpHash(op);
        (v, r, s) = vm.sign(USER_PK, MessageHashUtils.toEthSignedMessageHash(uh));
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    function _mustRevert(EpOp memory op, bytes memory rev) internal {
        EpOp[] memory ops = new EpOp[](1);
        ops[0] = op;
        vm.expectRevert(rev);
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
    }

    function _send(EpOp memory op) internal returns (bool success, uint256 actualGasCost, uint256 actualGasUsed, uint256 charged) {
        vm.recordLogs();
        EpOp[] memory ops = new EpOp[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, success, actualGasCost, actualGasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            } else if (logs[i].topics[0] == PM.UserOperationCharged.selector) {
                (charged,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
    }

    function _aa33(bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA33 reverted", inner);
    }

    function test_ledger_deposit_reserves_and_settles_ceil() public {
        uint256 need = _need();
        assertGt(need, 0);
        assertEq(pm.tokenCost(1, RATE), 1, "ceil: 1 wei is one raw unit at rate 2300");
        assertEq(pm.tokenCost(1e18, RATE), RATE);
        _fund(need);
        assertEq(pm.availableCredit(address(acct)), need);
        assertEq(usdg.balanceOf(address(pm)), need);
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        (bool ok, uint256 weiCost, uint256 used, uint256 charged) = _send(_sign(_op(_trade()), need, pm.ALLOWANCE_TYPEHASH()));
        assertTrue(ok);
        assertGt(charged, 0);
        assertLe(charged, need, "charge stays inside the signed reservation");
        assertEq(pm.reservedOf(address(acct)), 0);
        assertEq(pm.creditOf(address(acct)), need - charged);
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, charged, "fee is treasury funds, not player credit");
        assertEq(pm.availableCredit(address(acct)), need - charged);
        assertGe(charged, pm.tokenCost(weiCost, RATE), "USDG covers the ETH the protocol paid, rounded up");
        console2.log("warm trade gas", used);
        console2.log("warm trade charged raw", charged);
        assertEq(pm.owedOf(address(acct)), 0);
    }

    function test_reverted_trade_still_charges_credit_and_drops_in_execution_topup() public {
        uint256 need = _need();
        _fund(need);
        uint256 top = 5_000_000;
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](3);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), top)));
        calls[1] = MiniAccount.Call(address(pm), 0, abi.encodeWithSelector(DEPOSIT_SEL, address(acct), top));
        calls[2] = MiniAccount.Call(address(rev), 0, abi.encodeCall(Reverter.fail, ()));
        uint256 walletBefore = usdg.balanceOf(address(acct));
        (bool ok,, , uint256 charged) = _send(_sign(_op(_batch(calls)), need, pm.OP_QUOTE_TYPEHASH()));
        assertFalse(ok, "trade reverts");
        assertGt(charged, 0, "gas still taken from pre-existing credit");
        assertEq(pm.creditOf(address(acct)), need - charged, "reverted top-up is not credit");
        assertEq(usdg.balanceOf(address(acct)), walletBefore, "wallet USDG restored");
        assertEq(pm.reservedOf(address(acct)), 0);
    }

    function test_two_ops_one_sender_one_bundle_reserve_before_execution() public {
        uint256 need = _need();
        _fund(need * 2 - 1);
        EpOp memory a = _sign(_op(_trade()), need, pm.ALLOWANCE_TYPEHASH());
        EpOp memory b = _op(_trade());
        b.nonce = a.nonce + 1;
        b = _sign(b, need, pm.ALLOWANCE_TYPEHASH());
        EpOp[] memory ops = new EpOp[](2);
        ops[0] = a;
        ops[1] = b;
        vm.prank(bundler, bundler);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                1,
                "AA33 reverted",
                abi.encodeWithSelector(PM.InsufficientCredit.selector, need - 1, need)
            )
        );
        ep.handleOps(ops, payable(bundler));
        assertEq(pm.reservedOf(address(acct)), 0, "failed bundle leaves no reservation");

        _fund(1);
        assertEq(pm.availableCredit(address(acct)), need * 2);
        b = _op(_trade());
        b.nonce = ep.getNonce(address(acct), 0) + 1;
        a = _sign(_op(_trade()), need, pm.ALLOWANCE_TYPEHASH());
        b = _sign(b, need, pm.ALLOWANCE_TYPEHASH());
        ops[0] = a;
        ops[1] = b;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
        assertEq(pm.reservedOf(address(acct)), 0);
        assertLt(pm.creditOf(address(acct)), need * 2);
        assertGt(pm.creditOf(address(acct)), 0);
    }

    function test_withdraw_all_after_its_own_gas_nothing_pending() public {
        uint256 need = _need();
        _fund(need + 7_000_000);
        bytes memory cd = abi.encodeCall(MiniAccount.execute, (address(pm), 0, abi.encodeCall(PM.withdraw, ())));
        uint256 before = usdg.balanceOf(address(acct));
        (bool ok,, , uint256 charged) = _send(_sign(_op(cd), need, pm.OP_QUOTE_TYPEHASH()));
        assertTrue(ok);
        assertGt(charged, 0);
        assertEq(pm.creditOf(address(acct)), 0, "no dust");
        assertEq(pm.reservedOf(address(acct)), 0);
        assertEq(usdg.balanceOf(address(acct)) - before, need + 7_000_000 - charged);
        assertEq(pm.withdrawPending(address(acct)), false);
    }

    function test_release_pulls_the_shortfall_and_leaves_the_gas_reservation() public {
        uint256 need = _need();
        _fund(need + 5_000_000);
        usdg.mint(address(acct), 1_000_000);
        address to = makeAddr("recipient");
        uint256 pull = 3_000_000;
        uint256 sendAmt = 1_000_000 + pull;
        MiniAccount.Call[] memory cs = new MiniAccount.Call[](2);
        cs[0] = MiniAccount.Call(address(pm), 0, abi.encodeCall(PM.release, (pull)));
        cs[1] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.transfer, (to, sendAmt)));
        (bool ok,,, uint256 charged) = _send(_sign(_op(_batch(cs)), need, pm.OP_QUOTE_TYPEHASH()));
        assertTrue(ok);
        assertEq(usdg.balanceOf(to), sendAmt, "wallet plus released credit");
        assertEq(pm.creditOf(address(acct)), need + 5_000_000 - pull - charged);
        assertEq(pm.reservedOf(address(acct)), 0);

        uint256 all = pm.creditOf(address(acct));
        MiniAccount.Call[] memory tooMuch = new MiniAccount.Call[](1);
        tooMuch[0] = MiniAccount.Call(address(pm), 0, abi.encodeCall(PM.release, (all)));
        (bool released,,, uint256 gasOnly) = _send(_sign(_op(_batch(tooMuch)), need, pm.OP_QUOTE_TYPEHASH()));
        assertFalse(released, "cannot take the gas reservation");
        assertEq(pm.reservedOf(address(acct)), 0);
        assertEq(pm.creditOf(address(acct)), all - gasOnly);
    }

    function test_reservation_blocks_withdraw_until_postOp_releases_it() public {
        uint256 need = _need();
        _fund(need * 2);
        EpOp memory trade = _sign(_op(_trade()), need, pm.ALLOWANCE_TYPEHASH());
        bytes32 tradeHash = ep.getUserOpHash(trade);
        vm.prank(address(ep));
        (bytes memory ctx, uint256 validationData) = pm.validatePaymasterUserOp(_asPm(trade), tradeHash, _maxCost());
        assertEq(validationData & 1, 0, "signature accepted");
        assertEq(pm.reservedOf(address(acct)), need);
        vm.prank(address(acct));
        vm.expectRevert(PM.Pending.selector);
        pm.withdraw();
        bytes memory wd = abi.encodeCall(MiniAccount.execute, (address(pm), 0, abi.encodeCall(PM.withdraw, ())));
        EpOp memory withdrawOp = _sign(_op(wd), need, pm.OP_QUOTE_TYPEHASH());
        bytes32 withdrawHash = ep.getUserOpHash(withdrawOp);
        vm.expectRevert(PM.Pending.selector);
        vm.prank(address(ep));
        pm.validatePaymasterUserOp(_asPm(withdrawOp), withdrawHash, _maxCost());
        vm.prank(address(ep));
        pm.postOp(PostOpMode.opSucceeded, ctx, 1000, MAX_FEE);
        assertEq(pm.reservedOf(address(acct)), 0);
        uint256 left = pm.creditOf(address(acct));
        uint256 bal = usdg.balanceOf(address(acct));
        vm.prank(address(acct));
        pm.withdraw();
        assertEq(pm.creditOf(address(acct)), 0);
        assertEq(usdg.balanceOf(address(acct)) - bal, left, "100% of remaining credit");
    }

    function test_bootstrap_once_only_and_reverted_setup_is_unsecured() public {
        MiniAccount fresh = new MiniAccount(address(ep), user);
        usdg.mint(address(fresh), 50_000_000);
        uint256 dep = pm.SETUP_DEPOSIT();
        // Shrink the op so its signed max fits under $2 at 0.01 gwei. This test uses 1 gwei, so deposit the need.
        uint256 need = _need();
        uint256 fund = need > dep ? need : dep;
        bytes memory cd = _setup(address(fresh), fund, false);
        EpOp memory op = _opFor(address(fresh), cd, ep.getNonce(address(fresh), 0));
        op = _signFor(op, fund, USER_PK);
        (bool ok,, uint256 used, uint256 charged) = _send(op);
        assertTrue(ok);
        assertTrue(pm.bootstrapUsed(address(fresh)));
        assertEq(pm.creditOf(address(fresh)), fund - charged);
        assertEq(charged > 0, true);
        console2.log("bootstrap gas", used);
        console2.log("bootstrap charged raw", charged);

        // Second zero-credit attempt is impossible: credit remains. Drain it with a direct withdraw, then retry.
        vm.prank(address(fresh));
        pm.withdraw();
        assertEq(pm.creditOf(address(fresh)), 0);
        EpOp memory again = _opFor(address(fresh), cd, ep.getNonce(address(fresh), 0));
        again = _signFor(again, fund, USER_PK);
        _mustRevert(again, _aa33(abi.encodeWithSelector(PM.InsufficientCredit.selector, 0, fund)));

        // A setup whose deposit fails in execution still consumes the once-only flag and pays no USDG.
        MiniAccount grief = new MiniAccount(address(ep), user);
        bytes memory bad = _setup(address(grief), fund, false);
        EpOp memory g = _signFor(_opFor(address(grief), bad, ep.getNonce(address(grief), 0)), fund, USER_PK);
        uint256 ethBefore = pm.getDeposit();
        (ok,, used, charged) = _send(g);
        assertFalse(ok);
        assertTrue(pm.bootstrapUsed(address(grief)));
        assertEq(pm.creditOf(address(grief)), 0);
        assertEq(charged, 0, "reverted setup collects no USDG");
        uint256 unpaid = ethBefore - pm.getDeposit();
        assertGt(unpaid, 0, "protocol ETH is the unsecured exposure");
        console2.log("reverted bootstrap unpaid wei", unpaid);
        console2.log("reverted bootstrap gas", used);
        g = _signFor(_opFor(address(grief), _setup(address(grief), fund, false), ep.getNonce(address(grief), 0)), fund, USER_PK);
        _mustRevert(g, _aa33(abi.encodeWithSelector(PM.InsufficientCredit.selector, 0, fund)));
    }

    function test_max_wrong_spender_and_mismatched_deposit_rejected() public {
        uint256 need = _need();
        _fund(need * 2);
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](1);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), type(uint256).max)));
        _mustRevert(
            _sign(_op(_batch(calls)), need, pm.ALLOWANCE_TYPEHASH()),
            _aa33(abi.encodeWithSelector(PM.BadCreditCall.selector))
        );

        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (treasury, 10)));
        // a non-paymaster approve is an ordinary call, not a credit leg
        (bool ok,,,) = _send(_sign(_op(_batch(calls)), need, pm.ALLOWANCE_TYPEHASH()));
        assertTrue(ok);

        calls = new MiniAccount.Call[](2);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), need)));
        calls[1] = MiniAccount.Call(address(pm), 0, abi.encodeWithSelector(DEPOSIT_SEL, treasury, need));
        _mustRevert(
            _sign(_op(_batch(calls)), need, pm.ALLOWANCE_TYPEHASH()),
            _aa33(abi.encodeWithSelector(PM.BadCreditCall.selector))
        );

        MockUSDG other = new MockUSDG(6);
        other.mint(address(acct), need);
        calls[0] = MiniAccount.Call(address(other), 0, abi.encodeCall(ERC20.approve, (address(pm), need)));
        calls[1] = MiniAccount.Call(address(pm), 0, abi.encodeWithSelector(DEPOSIT_SEL, address(acct), need));
        _mustRevert(
            _sign(_op(_batch(calls)), need, pm.ALLOWANCE_TYPEHASH()),
            _aa33(abi.encodeWithSelector(PM.BadCreditCall.selector))
        );
    }

    function test_caps_launch_domain_and_bootstrap_gas_bound() public {
        uint256 need = _need();
        _fund(need);
        EpOp memory wide = _op(_trade());
        wide.accountGasLimits = bytes32((VERIF_GAS << 128) | TRADE_CAP);
        uint256 units = TRADE_CAP + VERIF_GAS + PVG + PM_VERIF + PM_POST;
        uint256 tok = pm.tokenCost(units * MAX_FEE, RATE);
        _fund(tok);
        _mustRevert(
            _sign(wide, tok, pm.ALLOWANCE_TYPEHASH()),
            _aa33(abi.encodeWithSelector(PM.GasLimitAboveCap.selector, units, TRADE_CAP))
        );

        // Launch domain selects the larger cap. The reusable allowance domain does not.
        EpOp memory launch = _op(_trade());
        launch.accountGasLimits = bytes32((VERIF_GAS << 128) | uint256(8_000_000));
        units = 8_000_000 + VERIF_GAS + PVG + PM_VERIF + PM_POST;
        tok = pm.tokenCost(units * MAX_FEE, RATE);
        _fund(tok);
        (bool ok,,,) = _send(_sign(launch, tok, pm.LAUNCH_QUOTE_TYPEHASH()));
        assertTrue(ok, "launch domain admits the wider cap");
        EpOp memory trade = _op(_trade());
        trade.accountGasLimits = bytes32((VERIF_GAS << 128) | uint256(8_000_000));
        _mustRevert(
            _sign(trade, tok, pm.ALLOWANCE_TYPEHASH()),
            _aa33(abi.encodeWithSelector(PM.GasLimitAboveCap.selector, units, TRADE_CAP))
        );
    }

    function test_in_execution_topup_cannot_fund_its_own_reservation() public {
        uint256 need = _need();
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](3);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), need)));
        calls[1] = MiniAccount.Call(address(pm), 0, abi.encodeWithSelector(DEPOSIT_SEL, address(acct), need));
        calls[2] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.transfer, (address(acct), 0)));
        _mustRevert(
            _sign(_op(_batch(calls)), need, pm.OP_QUOTE_TYPEHASH()),
            _aa33(abi.encodeWithSelector(PM.InsufficientCredit.selector, 0, need))
        );
        assertEq(pm.creditOf(address(acct)), 0);
        assertEq(usdg.balanceOf(address(pm)), 0);
    }

    function test_postOp_gas_under_floor_and_validation_ignores_token() public {
        uint256 need = _need();
        _fund(need);
        EpOp memory op = _sign(_op(_trade()), need, pm.OP_QUOTE_TYPEHASH());
        usdg.setGuardReads(true);
        bytes32 opHash = ep.getUserOpHash(op);
        PmOp memory packed = _asPm(op);
        uint256 g0 = gasleft();
        vm.prank(address(ep));
        (bytes memory ctx,) = pm.validatePaymasterUserOp(packed, opHash, _maxCost());
        usdg.setGuardReads(false);
        uint256 validateGas = g0 - gasleft();
        console2.log("validatePaymasterUserOp gas", validateGas);
        g0 = gasleft();
        vm.prank(address(ep));
        pm.postOp(PostOpMode.opSucceeded, ctx, _maxCost() / 4, MAX_FEE);
        uint256 postGas = g0 - gasleft();
        console2.log("postOp gas", postGas);
        assertLt(postGas, pm.MIN_PM_POST_OP_GAS_LIMIT(), "measured postOp fits the signed floor");
        assertEq(pm.reservedOf(address(acct)), 0);
    }

    function test_low_postOp_limit_rejected() public {
        uint256 need = _need();
        _fund(need);
        EpOp memory op = _op(_trade());
        bytes memory prefix = abi.encodePacked(address(pm), uint128(PM_VERIF), uint128(149_999));
        uint48 until = uint48(block.timestamp + 120);
        uint48 afterTs = uint48(block.timestamp - 10);
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, RATE, need, new bytes(65));
        bytes32 h = pm.getHash(op.sender, until, afterTs, RATE, need);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, RATE, need, r, s, v);
        (v, r, s) = vm.sign(USER_PK, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)));
        op.signature = abi.encodePacked(r, s, v);
        _mustRevert(
            op, _aa33(abi.encodeWithSelector(PM.PostOpGasLimitTooLow.selector, 149_999, pm.MIN_PM_POST_OP_GAS_LIMIT()))
        );
    }

    function test_pause_and_no_eth_refill_on_charge() public {
        uint256 dep = pm.getDeposit();
        uint256 need = _need();
        _fund(need);
        (bool ok,,,) = _send(_sign(_op(_trade()), need, pm.ALLOWANCE_TYPEHASH()));
        assertTrue(ok);
        assertLt(pm.getDeposit(), dep, "ETH deposit falls and is not refilled from USDG");
        vm.prank(owner);
        pm.setPaused(true);
        _fund(need);
        _mustRevert(_sign(_op(_trade()), need, pm.ALLOWANCE_TYPEHASH()), _aa33(abi.encodeWithSelector(PM.Paused.selector)));
    }

    function test_claim_is_not_player_credit() public {
        uint256 need = _need();
        _fund(need);
        vm.mockCall(address(usdg), abi.encodeWithSelector(ERC20.transfer.selector, treasury), abi.encode(false));
        (bool ok,, , uint256 charged) = _send(_sign(_op(_trade()), need, pm.ALLOWANCE_TYPEHASH()));
        assertTrue(ok);
        vm.clearMockedCalls();
        assertEq(pm.claimOf(treasury), charged);
        assertEq(pm.creditOf(treasury), 0, "earnings are not player credit");
        uint256 tBefore = usdg.balanceOf(treasury);
        pm.claim(treasury);
        assertEq(usdg.balanceOf(treasury) - tBefore, charged);
        assertEq(pm.claimOf(treasury), 0);
        assertGt(pm.creditOf(address(acct)), 0);
    }

    function test_setup_below_two_dollars_is_not_bootstrap() public {
        MiniAccount fresh = new MiniAccount(address(ep), user);
        usdg.mint(address(fresh), 50_000_000);
        // Force a tiny max token cost with tiny fees so $2 is the binding minimum.
        EpOp memory op = _opFor(address(fresh), _setup(address(fresh), pm.SETUP_DEPOSIT() - 1, false), 0);
        op.gasFees = bytes32((uint256(1) << 128) | uint256(1));
        uint256 tiny = pm.tokenCost(_gasUnits(), 1);
        assertLt(tiny, pm.SETUP_DEPOSIT());
        op = _signFor(op, tiny, USER_PK);
        vm.expectRevert();
        _send(op);
        assertFalse(pm.bootstrapUsed(address(fresh)));
    }

    function _setup(address account, uint256 amount, bool revertAfter) internal view returns (bytes memory) {
        uint256 n = revertAfter ? 3 : 2;
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](n);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), amount)));
        calls[1] = MiniAccount.Call(address(pm), 0, abi.encodeWithSelector(DEPOSIT_SEL, account, amount));
        if (revertAfter) calls[2] = MiniAccount.Call(address(rev), 0, abi.encodeCall(Reverter.fail, ()));
        return abi.encodeCall(MiniAccount.executeBatch, (calls));
    }

    function _opFor(address sender, bytes memory callData, uint256 nonce) internal pure returns (EpOp memory op) {
        op.sender = sender;
        op.nonce = nonce;
        op.callData = callData;
        op.accountGasLimits = bytes32((VERIF_GAS << 128) | CALL_GAS);
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((TIP << 128) | MAX_FEE);
    }

    function _signFor(EpOp memory op, uint256 maxTok, uint256 userPk) internal view returns (EpOp memory) {
        bytes memory prefix = abi.encodePacked(address(pm), uint128(PM_VERIF), uint128(PM_POST));
        uint48 until = uint48(block.timestamp + 120);
        uint48 afterTs = uint48(block.timestamp - 10);
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, RATE, maxTok, new bytes(65));
        bytes32 h = pm.getOpHash(_asPm(op), until, afterTs, RATE, maxTok);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, RATE, maxTok, r, s, v);
        (v, r, s) = vm.sign(userPk, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)));
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    function _copy(EpOp memory op) internal pure returns (EpOp memory) {
        return op;
    }
}


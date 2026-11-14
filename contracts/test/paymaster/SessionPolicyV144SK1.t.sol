// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Regression for audit 2026-11-14 SK-1 (docs/audit-2026-11-14.md) on session policy 1.4.4, with the real MAv2
// account and EntryPoint. Formerly OpenFinding_SK1 (the drain PoC against 1.4.3).
// Run: forge test --match-contract SessionPolicyV144SK1Test -vv

import {PaymasterBootstrapFixture, BootstrapAccount, BootstrapFactory, BootstrapBuy} from "./PaymasterBootstrap.t.sol";
import {RuntimeMarket} from "./PaymasterRuntime.t.sol";
import {MockUSDG, MiniAccount} from "./PaymasterTestBase.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {PackedUserOperation as PmOp} from "../../src/paymaster/IPaymasterV07.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {DisciplePaymasterV5 as PM} from "../../src/paymaster/DisciplePaymasterV5.sol";
import {DiscipleSessionPolicyV144 as Policy} from "../../src/session/DiscipleSessionPolicyV144.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

contract SessionPolicyV144SK1Test is PaymasterBootstrapFixture {
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

    function test_SK1_stolenSessionKey_cannotDrainBeyondCap() public {
        assertTrue(_sendAs(bundler, _ownerSetup(5 ether)), "owner setup");
        uint256 creditStart = v5.creditOf(smart);
        uint256 walletStart = usdg.balanceOf(smart);

        // (1) The sweep now counts against cap0: execution reverts, nothing moves into credit.
        uint256 sweep = 9_000 ether;
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](2);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(v5), sweep)));
        calls[1] = MiniAccount.Call(address(v5), 0, abi.encodeWithSelector(DEPOSIT_SEL, smart, sweep));
        assertFalse(_sendAs(attacker, _sessionOp(abi.encodeCall(MiniAccount.executeBatch, (calls)), FEE)), "sweep refused");
        assertEq(usdg.balanceOf(smart), walletStart, "wallet USDG untouched");
        assertGt(policy5.sessionOf(smart, ENTITY).spent0, 0, "the reverted op still used up its gas ceiling");

        // (2) Reverting ops each debit their gas ceiling in validation; once cap0 is used up they can't be sent.
        bytes memory reverting = abi.encodeCall(
            MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.approve, (address(trade), 1)))
        );
        uint256 sent;
        for (uint256 i; i < 20; ++i) {
            EpOp memory op = _sessionOp(reverting, ATTACK_FEE);
            EpOp[] memory ops = new EpOp[](1);
            ops[0] = op;
            vm.prank(attacker, attacker);
            try ep.handleOps(ops, payable(attacker)) {
                ++sent;
            } catch {
                sessionNonce--; // nonce not used
                break;
            }
        }
        assertLt(sent, 20, "validation stops the drain");
        assertLe(policy5.sessionOf(smart, ENTITY).spent0, CAP0, "spent0 never passes cap0");
        assertLe(creditStart - v5.creditOf(smart), CAP0, "credit burned stays within the session cap");
        console2.log("reverting ops accepted before the cap stopped them", sent);
        console2.log("credit burned", creditStart - v5.creditOf(smart));
    }
}

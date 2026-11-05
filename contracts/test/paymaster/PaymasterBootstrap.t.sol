// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymasterTestBase, MockUSDG, MiniAccount} from "./PaymasterTestBase.sol";
import {EntryPoint} from "../vendor/aa-v07/core/EntryPoint.sol";
import {SenderCreator} from "../vendor/aa-v07/core/SenderCreator.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {DiscipleSessionPolicy as Policy} from "../../src/session/DiscipleSessionPolicy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface BootstrapFactory {
    function getAddressSemiModular(address owner, uint256 salt) external view returns (address);
    function createSemiModularAccount(address owner, uint256 salt) external returns (address);
}
interface BootstrapAccount {
    function installValidation(bytes25 config, bytes4[] calldata selectors, bytes calldata data, bytes[] calldata hooks) external;
}

contract BootstrapBuy {
    MockUSDG public immutable usdg;
    MockUSDG public immutable token;
    DisciplePaymaster public immutable paymaster;
    constructor(MockUSDG u, MockUSDG t, DisciplePaymaster p) { usdg = u; token = t; paymaster = p; }
    function curveOf(address) external view returns (address) { return address(this); }
    function quote() external view returns (address) { return address(usdg); }
    function quoteExactIn(address, bool, uint256 amount) external pure returns (uint256, uint256, uint256) { return (amount, 0, 0); }
    function buyExactIn(address, uint256 amount, uint256, address recipient, uint256) external returns (uint256) {
        require(paymaster.exposure() != 0 && usdg.balanceOf(address(paymaster)) != 0, "gas prepaid before buy");
        usdg.transferFrom(msg.sender, address(this), amount);
        token.mint(recipient, amount);
        return amount;
    }
}

/// @notice Real deployed Alchemy SMA/factory/SingleSigner bytecode, real EntryPoint v0.7, no RPC in tests.
/// Owner-signed MAv2 deferred approval executes in ACCOUNT VALIDATION, before paymaster validation.
/// No permit, replacement factory, ETH on the account, or approval in execution is needed to secure gas.
contract PaymasterBootstrapTest is PaymasterTestBase {
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address factory;
    address singleSigner;
    address smart;
    MockUSDG bought;
    BootstrapBuy trade;
    Policy policy;
    uint256 constant SESSION_PK = 0xCAFE;
    uint32 constant ENTITY = 8;
    uint256 constant BUY = 10e6;

    function setUp() public {
        _setUp(6);
        // Preserve the actual EntryPoint implementation at its canonical address. Its constructor-created
        // SenderCreator is re-instantiated with the canonical EntryPoint as its immutable authorized caller.
        address creator = vm.computeCreateAddress(address(ep), 1);
        vm.etch(EP, address(ep).code);
        vm.prank(EP);
        SenderCreator senderCreator = new SenderCreator();
        vm.etch(creator, address(senderCreator).code);
        ep = EntryPoint(payable(EP));
        pm = new DisciplePaymaster(EP, address(usdg), owner, signer, treasury, rate / 10, rate * 10, 100e6, 100_000);
        pm.deposit{value: 1 ether}();
        string memory fixture = vm.readFile("test/fixtures/mav2-rht.json");
        factory = vm.parseJsonAddress(fixture, ".factory.address");
        address implementation = vm.parseJsonAddress(fixture, ".implementation.address");
        singleSigner = vm.parseJsonAddress(fixture, ".singleSigner.address");
        vm.etch(factory, vm.parseJsonBytes(fixture, ".factory.code"));
        vm.etch(implementation, vm.parseJsonBytes(fixture, ".implementation.code"));
        vm.etch(singleSigner, vm.parseJsonBytes(fixture, ".singleSigner.code"));
        smart = BootstrapFactory(factory).getAddressSemiModular(user, 0);
        usdg.mint(smart, 100e6);
        bought = new MockUSDG(6);
        trade = new BootstrapBuy(usdg, bought, pm);
        policy = new Policy(address(0), address(pm));
        assertEq(smart.code.length, 0);
        assertEq(smart.balance, 0);
        assertEq(usdg.allowance(smart, address(pm)), 0);
    }

    function _nativeSig(uint256 pk, bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
    function _install() internal view returns (bytes memory) {
        Policy.SessionConfig memory cfg;
        cfg.validUntil = uint48(block.timestamp + 1 days);
        cfg.permissions = (1 << 10) - 1;
        cfg.router = address(trade);
        cfg.launchpad = address(trade);
        cfg.quote0 = address(usdg);
        cfg.cap0 = type(uint128).max;
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = MiniAccount.execute.selector;
        selectors[1] = MiniAccount.executeBatch.selector;
        bytes[] memory hooks = new bytes[](2);
        hooks[0] = abi.encodePacked(bytes25(abi.encodePacked(address(policy), ENTITY, uint8(1))), abi.encode(ENTITY, cfg));
        hooks[1] = abi.encodePacked(bytes25(abi.encodePacked(address(policy), ENTITY | policy.EXEC_HOOK_FLAG(), uint8(4))), abi.encode(ENTITY | policy.EXEC_HOOK_FLAG()));
        return abi.encodeCall(BootstrapAccount.installValidation, (bytes25(abi.encodePacked(singleSigner, ENTITY, uint8(1))), selectors, abi.encode(ENTITY, vm.addr(SESSION_PK)), hooks));
    }
    function _buyCalls(bool install) internal view returns (bytes memory) {
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](install ? 4 : 3);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), type(uint256).max)));
        uint256 i = 1;
        if (install) calls[i++] = MiniAccount.Call(smart, 0, _install());
        calls[i++] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(trade), BUY)));
        calls[i] = MiniAccount.Call(address(trade), 0, abi.encodeCall(BootstrapBuy.buyExactIn, (address(bought), BUY, BUY, smart, block.timestamp + 60)));
        return abi.encodeCall(MiniAccount.executeBatch, (calls));
    }
    function _base(bool bootstrap) internal view returns (EpOp memory op) {
        op.sender = smart;
        op.nonce = bootstrap ? uint256(3) << 64 : uint256(ENTITY) << 72;
        if (bootstrap) op.initCode = abi.encodePacked(factory, abi.encodeCall(BootstrapFactory.createSemiModularAccount, (user, 0)));
        op.callData = bootstrap ? _buyCalls(true) : abi.encodePacked(bytes4(0x8dd7712f), _buyCalls(false));
        op.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(800_000));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((TIP << 128) | MAX_FEE);
        uint256 maxCost = (500_000 + 800_000 + 100_000 + PM_VERIF_GAS + PM_POSTOP_GAS) * MAX_FEE;
        op = _signPm(op, uint48(block.timestamp + 120), uint48(block.timestamp - 10), rate, pm.tokenCost(maxCost, rate), signerPk);
    }
    function _bootstrap(uint256 approvalSigner) internal view returns (EpOp memory op) {
        op = _base(true);
        bytes memory approval = abi.encodeCall(MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), type(uint256).max))));
        uint48 deadline = uint48(block.timestamp + 120);
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(uint256 chainId,address verifyingContract)"), block.chainid, smart));
        bytes32 action = keccak256(abi.encode(keccak256("DeferredAction(uint256 nonce,uint48 deadline,bytes call)"), op.nonce, deadline, keccak256(approval)));
        bytes memory auth = abi.encodePacked(uint8(0), _nativeSig(approvalSigner, MessageHashUtils.toTypedDataHash(domain, action)));
        bytes memory encoded = abi.encodePacked(uint168(1), deadline, approval);
        op.signature = abi.encodePacked(uint32(encoded.length), encoded, uint32(auth.length), auth, hex"ff00", _nativeSig(userPk, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op))));
    }

    function test_USDGOnlyNewAccount_deployInstallAndFirstBuy_thenSessionTap() public {
        uint256 depositBefore = pm.getDeposit();
        (bool ok, uint256 gasCost, uint256 charged) = _sendRecord(_bootstrap(userPk));
        assertTrue(ok, "deploy + install + buy succeeds");
        assertGt(smart.code.length, 0);
        assertEq(smart.balance, 0, "no native ETH bootstrap");
        assertEq(bought.balanceOf(smart), BUY);
        assertTrue(policy.sessionOf(smart, ENTITY).active);
        assertEq(usdg.allowance(smart, address(pm)), type(uint256).max);
        assertGe(charged, pm.tokenCost(gasCost, rate), "setup and first buy fully paid in USDG");
        EpOp memory next = _base(false);
        next.signature = abi.encodePacked(hex"ff00", _nativeSig(SESSION_PK, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(next))));
        (ok, gasCost, charged) = _sendRecord(next);
        assertTrue(ok, "next one-tap buy is signed only by session key");
        assertGe(charged, pm.tokenCost(gasCost, rate));
        assertEq(bought.balanceOf(smart), 2 * BUY);
        assertGt(policy.sessionOf(smart, ENTITY).spent0, BUY, "policy includes gas cap");
        assertLt(pm.getDeposit(), depositBefore);
        assertEq(pm.exposure(), 0);
        assertEq(pm.owedOf(smart), 0);
    }
    function test_noDeferredApproval_sameBatchApprovalCannotBootstrap() public {
        EpOp memory op = _base(true);
        op.nonce = uint256(1) << 64;
        op.signature = abi.encodePacked(hex"ff00", _nativeSig(userPk, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op))));
        uint256 depositBefore = pm.getDeposit();
        vm.expectRevert();
        _send(op);
        assertEq(pm.getDeposit(), depositBefore);
        assertEq(usdg.allowance(smart, address(pm)), 0);
        assertEq(bought.balanceOf(smart), 0);
    }
    function test_invalidDeferredOwnerSignature_cannotGrantAllowanceOrSpendFloat() public {
        EpOp memory op = _bootstrap(0xBAD);
        uint256 depositBefore = pm.getDeposit();
        vm.expectRevert();
        _send(op);
        assertEq(pm.getDeposit(), depositBefore);
        assertEq(usdg.allowance(smart, address(pm)), 0);
        assertEq(smart.code.length, 0, "deployment rolls back");
    }
}

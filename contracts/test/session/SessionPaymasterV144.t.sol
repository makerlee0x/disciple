// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DiscipleSessionPolicyV144 as P} from "../../src/session/DiscipleSessionPolicyV144.sol";
import {PackedUserOperation} from "../../src/session/IERC6900.sol";
import {TKN, MockRouter, MockLaunchpad, MockCurve, MockTWM} from "./DiscipleSessionPolicy.t.sol";

contract Account144 {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public owner;
    address public sessionKey;
    P public policy;
    uint32 public entity;
    address public constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    constructor(address o) {
        owner = o;
    }

    function installSession(P p, uint32 e, address key, P.SessionConfig memory cfg) external {
        require(msg.sender == owner, "owner");
        policy = p;
        entity = e;
        sessionKey = key;
        p.onInstall(abi.encode(e, cfg));
        p.onInstall(abi.encode(e | p.EXEC_HOOK_FLAG()));
    }

    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external {
        require(msg.sender == ENTRY_POINT, "ep");
        policy.preUserOpValidationHook(entity, userOp, userOpHash);
        policy.preExecutionHook(entity | policy.EXEC_HOOK_FLAG(), msg.sender, 0, msg.data);
        (bool ok, bytes memory r) = address(this).call(userOp.callData[4:]);
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }

    function execute(address t, uint256 v, bytes calldata d) external payable {
        if (msg.sender != sessionKey) revert("unauthorized");
        policy.preRuntimeValidationHook(entity, msg.sender, msg.value, msg.data, "");
        policy.preExecutionHook(entity | policy.EXEC_HOOK_FLAG(), msg.sender, msg.value, msg.data);
        (bool ok, bytes memory r) = t.call{value: v}(d);
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }

    function executeBatch(Call[] calldata calls) external payable {
        if (msg.sender != address(this)) revert("self");
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory r) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) assembly { revert(add(r, 32), mload(r)) }
        }
    }
}

contract MockPmToken144 {
    address public usdg;

    constructor(address u) {
        usdg = u;
    }

    fallback() external {} // deposit / withdraw / release succeed as no-ops
}

contract MockUsdgRouter144 is MockRouter {
    constructor(TKN q) MockRouter(q) {}

    function usdg() external view returns (address) {
        return address(quote);
    }
}

/// @notice Policy 1.4.4 (audit 2026-11-14 SK-1/SK-2): the gas ceiling is debited in validation, deposits count
///         against the cap, and every session userOp must be sponsored by the v5 paymaster.
contract SessionPaymasterV144Test is Test {
    P policy;
    TKN usdg;
    TKN other;
    TKN rocket;
    MockUsdgRouter144 router;
    MockLaunchpad lp;
    MockTWM twm;
    Account144 acct;
    address owner = makeAddr("owner");
    address key = makeAddr("sessionKey");
    address pm;
    uint32 constant E = 8;
    uint128 constant CAP = 100e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new TKN("USDG");
        other = new TKN("OTHER");
        rocket = new TKN("RKT");
        router = new MockUsdgRouter144(usdg);
        lp = new MockLaunchpad();
        lp.set(address(rocket), address(new MockCurve(address(rocket), usdg)));
        twm = new MockTWM(usdg);
        pm = address(new MockPmToken144(address(usdg)));
        policy = new P(address(0), pm);
        acct = new Account144(owner);
        usdg.mint(address(acct), 1000e18);
        other.mint(address(acct), 1000e18);
        P.SessionConfig memory c;
        c.validUntil = uint48(block.timestamp + 24 hours);
        c.permissions = (1 << 10) - 1;
        c.router = address(router);
        c.launchpad = address(lp);
        c.trampWallManager = address(twm);
        c.quote0 = address(usdg);
        c.cap0 = CAP;
        vm.prank(owner);
        acct.installSession(policy, E, key, c);
    }

    function _pmd(uint256 maxTok) internal view returns (bytes memory) {
        return abi.encodePacked(
            pm,
            uint128(100_000),
            uint128(160_000),
            uint48(block.timestamp + 60),
            uint48(block.timestamp - 1),
            uint256(2_300_000_000),
            maxTok,
            new bytes(65)
        );
    }

    function _buy(uint256 amount) internal view returns (Account144.Call memory) {
        return Account144.Call(
            address(router),
            0,
            abi.encodeCall(MockRouter.buyExactIn, (address(rocket), amount, amount, address(acct), block.timestamp))
        );
    }

    function _trade(uint256 amount) internal view returns (Account144.Call[] memory cs) {
        cs = new Account144.Call[](2);
        cs[0] = Account144.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), amount)));
        cs[1] = _buy(amount);
    }

    function _uo(Account144.Call[] memory cs, uint256 maxTok) internal view returns (PackedUserOperation memory op) {
        op.sender = address(acct);
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), abi.encodeCall(Account144.executeBatch, (cs)));
        op.paymasterAndData = _pmd(maxTok);
    }

    function _exec(PackedUserOperation memory op) internal {
        vm.prank(acct.ENTRY_POINT());
        acct.executeUserOp(op, keccak256("uo"));
    }

    function _reject(PackedUserOperation memory op, bytes memory rev) internal {
        vm.prank(acct.ENTRY_POINT());
        vm.expectRevert(rev);
        acct.executeUserOp(op, keccak256("uo"));
    }

    function test_moduleId_and_warmTradeDebitsGasWithoutPaymasterApprove() public {
        assertEq(policy.moduleId(), "disciple.session-policy.1.4.4");
        _exec(_uo(_trade(10e18), 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 12e18, "gas ceiling plus the trade, once");
        _exec(_uo(_trade(10e18), 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 24e18, "the next tap is counted again");
    }

    function test_gasCeilingAloneCanExceedTheCap() public {
        _reject(_uo(_trade(99e18), 2e18), abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 101e18, CAP));
    }

    function test_maxApproveAndUnmatchedDepositRejected() public {
        Account144.Call[] memory cs = new Account144.Call[](1);
        cs[0] = Account144.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, type(uint256).max)));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, type(uint256).max, 0));

        cs = new Account144.Call[](2);
        cs[0] = Account144.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, 5e18)));
        cs[1] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), address(acct), 4e18));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, 5e18, 4e18));
    }

    function test_topUpToSelf_countsTheDeposit() public {
        Account144.Call[] memory cs = new Account144.Call[](4);
        cs[0] = Account144.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, 5e18)));
        cs[1] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), address(acct), 5e18));
        cs[2] = Account144.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), 10e18)));
        cs[3] = _buy(10e18);
        _exec(_uo(cs, 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 17e18, "gas + deposit + trade (SK-1)");
    }

    /// SK-1: the gas debit lives in validation, so an op whose execution reverts still uses up cap.
    function test_SK1_gasDebitSurvivesExecutionRevert() public {
        Account144.Call[] memory cs = new Account144.Call[](1);
        cs[0] = Account144.Call(
            address(router), 0, abi.encodeCall(MockRouter.buyExactIn, (address(rocket), 1e18, 0, address(acct), block.timestamp))
        ); // minOut 0: passes the static check, reverts ZeroMinOut in the execution hook
        PackedUserOperation memory op = _uo(cs, 2e18);
        vm.prank(address(acct));
        policy.preUserOpValidationHook(E, op, keccak256("uo"));
        assertEq(policy.sessionOf(address(acct), E).spent0, 2e18, "debited in validation");
        uint32 execEntity = E | policy.EXEC_HOOK_FLAG();
        address ep = acct.ENTRY_POINT();
        bytes memory execData = abi.encodePacked(bytes4(0x8dd7712f), abi.encode(op, bytes32(0)));
        vm.prank(address(acct));
        vm.expectRevert(P.ZeroMinOut.selector);
        policy.preExecutionHook(execEntity, ep, 0, execData);
        assertEq(policy.sessionOf(address(acct), E).spent0, 2e18, "still debited after the execution revert");

        // Validation alone stops once the gas ceilings reach the cap: no unbounded reverting-op drain.
        for (uint256 i; i < 49; ++i) {
            vm.prank(address(acct));
            policy.preUserOpValidationHook(E, op, keccak256("uo"));
        }
        vm.prank(address(acct));
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 102e18, CAP));
        policy.preUserOpValidationHook(E, op, keccak256("uo"));
    }

    /// SK-1: moving the wallet into paymaster credit counts against the cap.
    function test_SK1_largeDepositExceedsCap() public {
        Account144.Call[] memory cs = new Account144.Call[](2);
        cs[0] = Account144.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, 900e18)));
        cs[1] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), address(acct), 900e18));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 901e18, CAP));
    }

    /// SK-2: a session userOp that is self-paid or names another paymaster is refused in validation.
    function test_SK2_unsponsoredOrForeignPaymasterRefused() public {
        PackedUserOperation memory op = _uo(_trade(1e18), 1e18);
        op.paymasterAndData = "";
        vm.prank(address(acct));
        vm.expectRevert(P.PaymasterRequired.selector);
        policy.preUserOpValidationHook(E, op, keccak256("uo"));

        op.paymasterAndData = _pmd(1e18);
        address other_ = makeAddr("otherPaymaster");
        assembly {
            let d := mload(add(op, 0xe0)) // paymasterAndData pointer
            mstore(add(d, 32), or(shl(96, other_), and(mload(add(d, 32)), 0xffffffffffffffffffffffff)))
        }
        vm.prank(address(acct));
        vm.expectRevert(P.PaymasterRequired.selector);
        policy.preUserOpValidationHook(E, op, keccak256("uo"));
    }

    function test_depositToSomeoneElseAndWrongTokenRejected() public {
        Account144.Call[] memory cs = new Account144.Call[](2);
        cs[0] = Account144.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, 5e18)));
        cs[1] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), owner, 5e18));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.RecipientNotAccount.selector));

        cs[0] = Account144.Call(address(other), 0, abi.encodeCall(ERC20.approve, (pm, 5e18)));
        cs[1] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), address(acct), 5e18));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.SpenderNotAllowed.selector, pm));
    }

    function test_withdrawIsAloneAndCountsTheGasCeiling() public {
        Account144.Call[] memory cs = new Account144.Call[](1);
        cs[0] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("withdraw()"))));
        _exec(_uo(cs, 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 2e18);

        cs = new Account144.Call[](2);
        cs[0] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("withdraw()"))));
        cs[1] = _buy(1e18);
        _reject(_uo(cs, 2e18), abi.encodeWithSelector(P.NotAllowed.selector, pm, bytes4(keccak256("withdraw()"))));
    }

    function test_release_may_share_a_batch_and_is_not_a_second_spend() public {
        Account144.Call[] memory trade = _trade(10e18);
        Account144.Call[] memory cs = new Account144.Call[](3);
        cs[0] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("release(uint256)")), 3e18));
        cs[1] = trade[0];
        cs[2] = trade[1];
        _exec(_uo(cs, 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 12e18);
        cs[0] = Account144.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("release(uint256)")), type(uint256).max));
        _reject(_uo(cs, 2e18), abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, type(uint256).max, 0));
    }

    function test_runtimeRevokeStillWorks_andMaxDoesNot() public {
        vm.prank(key);
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, 0)));
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, type(uint256).max, 0));
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, type(uint256).max)));
    }
}

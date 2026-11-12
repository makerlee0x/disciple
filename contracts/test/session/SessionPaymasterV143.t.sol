// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DiscipleSessionPolicyV143 as P} from "../../src/session/DiscipleSessionPolicyV143.sol";
import {PackedUserOperation} from "../../src/session/IERC6900.sol";
import {TKN, MockRouter, MockLaunchpad, MockCurve, MockTWM} from "./DiscipleSessionPolicy.t.sol";

contract Account143 {
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

contract MockUsdgRouter143 is MockRouter {
    constructor(TKN q) MockRouter(q) {}

    function usdg() external view returns (address) {
        return address(quote);
    }
}

/// @notice Policy 1.4.3: session keys may fund and withdraw their own v5 credit, and every sponsored op
///         debits the signed gas ceiling even when the batch contains no paymaster approval.
contract SessionPaymasterV143Test is Test {
    P policy;
    TKN usdg;
    TKN other;
    TKN rocket;
    MockUsdgRouter143 router;
    MockLaunchpad lp;
    MockTWM twm;
    Account143 acct;
    address owner = makeAddr("owner");
    address key = makeAddr("sessionKey");
    address pm = makeAddr("paymaster");
    uint32 constant E = 8;
    uint128 constant CAP = 100e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new TKN("USDG");
        other = new TKN("OTHER");
        rocket = new TKN("RKT");
        router = new MockUsdgRouter143(usdg);
        lp = new MockLaunchpad();
        lp.set(address(rocket), address(new MockCurve(address(rocket), usdg)));
        twm = new MockTWM(usdg);
        policy = new P(address(0), pm);
        acct = new Account143(owner);
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

    function _buy(uint256 amount) internal view returns (Account143.Call memory) {
        return Account143.Call(
            address(router),
            0,
            abi.encodeCall(MockRouter.buyExactIn, (address(rocket), amount, amount, address(acct), block.timestamp))
        );
    }

    function _trade(uint256 amount) internal view returns (Account143.Call[] memory cs) {
        cs = new Account143.Call[](2);
        cs[0] = Account143.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), amount)));
        cs[1] = _buy(amount);
    }

    function _uo(Account143.Call[] memory cs, uint256 maxTok) internal view returns (PackedUserOperation memory op) {
        op.sender = address(acct);
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), abi.encodeCall(Account143.executeBatch, (cs)));
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
        assertEq(policy.moduleId(), "disciple.session-policy.1.4.3");
        _exec(_uo(_trade(10e18), 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 12e18, "gas ceiling plus the trade, once");
        _exec(_uo(_trade(10e18), 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 24e18, "the next tap is counted again");
    }

    function test_gasCeilingAloneCanExceedTheCap() public {
        _reject(_uo(_trade(99e18), 2e18), abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 101e18, CAP));
    }

    function test_maxApproveAndUnmatchedDepositRejected() public {
        Account143.Call[] memory cs = new Account143.Call[](1);
        cs[0] = Account143.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, type(uint256).max)));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, type(uint256).max, 0));

        cs = new Account143.Call[](2);
        cs[0] = Account143.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, 5e18)));
        cs[1] = Account143.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), address(acct), 4e18));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, 5e18, 4e18));
    }

    function test_topUpToSelf_doesNotDoubleCountTheDeposit() public {
        Account143.Call[] memory cs = new Account143.Call[](4);
        cs[0] = Account143.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, 5e18)));
        cs[1] = Account143.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), address(acct), 5e18));
        cs[2] = Account143.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), 10e18)));
        cs[3] = _buy(10e18);
        _exec(_uo(cs, 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 12e18, "deposit is not a second spend");
    }

    function test_depositToSomeoneElseAndWrongTokenRejected() public {
        Account143.Call[] memory cs = new Account143.Call[](2);
        cs[0] = Account143.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (pm, 5e18)));
        cs[1] = Account143.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), owner, 5e18));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.RecipientNotAccount.selector));

        cs[0] = Account143.Call(address(other), 0, abi.encodeCall(ERC20.approve, (pm, 5e18)));
        cs[1] = Account143.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("deposit(address,uint256)")), address(acct), 5e18));
        _reject(_uo(cs, 1e18), abi.encodeWithSelector(P.SpenderNotAllowed.selector, pm));
    }

    function test_withdrawIsAloneAndCountsTheGasCeiling() public {
        Account143.Call[] memory cs = new Account143.Call[](1);
        cs[0] = Account143.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("withdraw()"))));
        _exec(_uo(cs, 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 2e18);

        cs = new Account143.Call[](2);
        cs[0] = Account143.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("withdraw()"))));
        cs[1] = _buy(1e18);
        _reject(_uo(cs, 2e18), abi.encodeWithSelector(P.NotAllowed.selector, pm, bytes4(keccak256("withdraw()"))));
    }

    function test_release_may_share_a_batch_and_is_not_a_second_spend() public {
        Account143.Call[] memory trade = _trade(10e18);
        Account143.Call[] memory cs = new Account143.Call[](3);
        cs[0] = Account143.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("release(uint256)")), 3e18));
        cs[1] = trade[0];
        cs[2] = trade[1];
        _exec(_uo(cs, 2e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 12e18);
        cs[0] = Account143.Call(pm, 0, abi.encodeWithSelector(bytes4(keccak256("release(uint256)")), type(uint256).max));
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

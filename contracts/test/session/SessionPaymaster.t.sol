// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DiscipleSessionPolicy as P} from "../../src/session/DiscipleSessionPolicy.sol";
import {PackedUserOperation} from "../../src/session/IERC6900.sol";
import {TKN, MockRouter, MockLaunchpad, MockCurve, MockTWM, MockMAv2} from "./DiscipleSessionPolicy.t.sol";

contract MockUsdgRouter is MockRouter {
    constructor(TKN q) MockRouter(q) {}

    function usdg() external view returns (address) {
        return address(quote);
    }
}

/// @notice Policy 1.4.0: USDG gas-fee approvals to the DISCIPLE paymaster (exact signed maxTokenCost, counted
///         against the USDG session cap). Uses the real MAv2 executeUserOp exec-hook data shape.
contract SessionPaymasterTest is Test {
    P policy;
    TKN usdg;
    TKN rocket;
    MockUsdgRouter router;
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    MockLaunchpad lp;
    MockTWM twm;
    MockMAv2 acct;
    address owner = makeAddr("owner");
    address key = makeAddr("sessionKey");
    address pm = makeAddr("paymaster");
    uint32 constant E = 8;
    uint128 constant CAP = 100e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new TKN("USDG");
        rocket = new TKN("RKT");
        router = new MockUsdgRouter(usdg);
        lp = new MockLaunchpad();
        lp.set(address(rocket), address(new MockCurve(address(rocket), usdg)));
        twm = new MockTWM(usdg);
        policy = new P(address(0), pm);
        acct = new MockMAv2(owner);
        usdg.mint(address(acct), 1000e18);
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

    function _pmd(address paymaster, uint256 maxTok) internal view returns (bytes memory) {
        return abi.encodePacked(
            paymaster,
            uint128(100_000),
            uint128(60_000),
            uint48(block.timestamp + 60),
            uint48(block.timestamp - 1),
            uint256(3000e18),
            maxTok,
            new bytes(65)
        );
    }

    function _approvePm(address tok, uint256 a) internal view returns (MockMAv2.Call memory) {
        return MockMAv2.Call(tok, 0, abi.encodeCall(ERC20.approve, (pm, a)));
    }

    function _buyCalls(uint256 pmAmt, uint256 buy) internal view returns (MockMAv2.Call[] memory cs) {
        cs = new MockMAv2.Call[](3);
        cs[0] = _approvePm(address(usdg), pmAmt);
        cs[1] = MockMAv2.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), buy)));
        cs[2] = MockMAv2.Call(
            address(router),
            0,
            abi.encodeCall(MockRouter.buyExactIn, (address(rocket), buy, buy, address(acct), block.timestamp))
        );
    }

    function _uo(MockMAv2.Call[] memory cs, bytes memory pmd) internal view returns (PackedUserOperation memory op) {
        op.sender = address(acct);
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), abi.encodeCall(MockMAv2.executeBatch, (cs)));
        op.paymasterAndData = pmd;
    }

    function _exec(PackedUserOperation memory op) internal {
        vm.prank(EP);
        acct.executeUserOp(op, keccak256("uo"));
    }

    function test_moduleId() public view {
        assertEq(policy.moduleId(), "disciple.session-policy.1.4.0");
        assertEq(policy.paymaster(), pm);
    }

    function test_exactPaymasterApprove_countsAgainstCap() public {
        _exec(_uo(_buyCalls(2e18, 10e18), _pmd(pm, 2e18)));
        assertEq(usdg.allowance(address(acct), pm), 2e18);
        assertEq(policy.sessionOf(address(acct), E).spent0, 12e18, "gas fee (max) + trade both counted");
    }

    function test_gasFeePushesOverCap() public {
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 101e18, CAP));
        _exec(_uo(_buyCalls(2e18, 99e18), _pmd(pm, 2e18)));
    }

    function test_revert_approveNotExact() public {
        vm.expectRevert(abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, 3e18, 2e18));
        _exec(_uo(_buyCalls(3e18, 10e18), _pmd(pm, 2e18)));
        vm.expectRevert(abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, 1e18, 2e18));
        _exec(_uo(_buyCalls(1e18, 10e18), _pmd(pm, 2e18)));
    }

    function test_revert_otherPaymasterInOp() public {
        vm.expectRevert(abi.encodeWithSelector(P.SpenderNotAllowed.selector, pm));
        _exec(_uo(_buyCalls(2e18, 10e18), _pmd(makeAddr("other"), 2e18)));
    }

    function test_revert_noPaymasterAndData() public {
        vm.expectRevert(abi.encodeWithSelector(P.SpenderNotAllowed.selector, pm));
        _exec(_uo(_buyCalls(2e18, 10e18), ""));
    }

    function test_revert_unlimitedApprove() public {
        vm.expectRevert(abi.encodeWithSelector(P.PaymasterApproveNotExact.selector, type(uint256).max, 2e18));
        _exec(_uo(_buyCalls(type(uint256).max, 10e18), _pmd(pm, 2e18)));
    }

    function test_revert_nonUsdgApproveToPaymaster() public {
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](1);
        cs[0] = _approvePm(address(rocket), 2e18);
        vm.expectRevert(abi.encodeWithSelector(P.SpenderNotAllowed.selector, pm));
        _exec(_uo(cs, _pmd(pm, 2e18)));
    }

    function test_runtimePath_refusedExceptRevoke() public {
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](1);
        cs[0] = _approvePm(address(usdg), 2e18);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.SpenderNotAllowed.selector, pm));
        acct.executeBatch(cs);
        cs[0] = _approvePm(address(usdg), 0);
        vm.prank(key);
        acct.executeBatch(cs); // revoke is always fine
        assertEq(policy.sessionOf(address(acct), E).spent0, 0);
    }

    function test_noPaymasterConfigured_refused() public {
        P p0 = new P(address(0), address(0));
        MockMAv2 a0 = new MockMAv2(owner);
        P.SessionConfig memory c;
        c.validUntil = uint48(block.timestamp + 1 hours);
        c.permissions = (1 << 10) - 1;
        c.router = address(router);
        c.launchpad = address(lp);
        c.quote0 = address(usdg);
        c.cap0 = CAP;
        vm.prank(owner);
        a0.installSession(p0, E, key, c);
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](1);
        cs[0] = _approvePm(address(usdg), 2e18);
        PackedUserOperation memory op;
        op.sender = address(a0);
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), abi.encodeCall(MockMAv2.executeBatch, (cs)));
        op.paymasterAndData = _pmd(pm, 2e18);
        vm.prank(EP);
        vm.expectRevert(abi.encodeWithSelector(P.SpenderNotAllowed.selector, pm));
        a0.executeUserOp(op, bytes32(0));
    }

    function test_sessionWithoutUsdgCap_cannotUsePaymaster() public {
        MockMAv2 a1 = new MockMAv2(owner);
        usdg.mint(address(a1), 10e18);
        P.SessionConfig memory c;
        c.validUntil = uint48(block.timestamp + 1 hours);
        c.permissions = (1 << 10) - 1;
        c.router = address(router);
        c.launchpad = address(lp);
        c.quote0 = address(rocket); // USDG not a capped quote
        c.cap0 = CAP;
        vm.prank(owner);
        a1.installSession(policy, E, key, c);
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](1);
        cs[0] = _approvePm(address(usdg), 2e18);
        PackedUserOperation memory op;
        op.sender = address(a1);
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), abi.encodeCall(MockMAv2.executeBatch, (cs)));
        op.paymasterAndData = _pmd(pm, 2e18);
        vm.prank(EP);
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 2e18, 0));
        a1.executeUserOp(op, bytes32(0));
    }
}

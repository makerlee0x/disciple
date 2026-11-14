// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Regression tests for the 2026-11-14 audit fixes PM-1 and PM-2 (docs/audit-2026-11-14.md).
// Inherits the PaymasterV5Test harness; run only these: --match-contract PaymasterV5AuditFixesTest --match-test test_PM

import {PaymasterV5Test} from "./PaymasterV5.t.sol";
import {MiniAccount} from "./PaymasterTestBase.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {DisciplePaymasterV5 as PM} from "../../src/paymaster/DisciplePaymasterV5.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";

contract PaymasterV5AuditFixesTest is PaymasterV5Test {
    address attacker = makeAddr("attacker");

    /// PM-1: a stranger's 1-unit deposit no longer locks a USDG-only account out of its one setup op.
    function test_PM1_dustDeposit_doesNotBlockBootstrap() public {
        MiniAccount fresh = new MiniAccount(address(ep), user);
        usdg.mint(address(fresh), 50_000_000);
        uint256 fund = _need() > pm.SETUP_DEPOSIT() ? _need() : pm.SETUP_DEPOSIT();

        usdg.mint(attacker, 1);
        vm.startPrank(attacker);
        usdg.approve(address(pm), 1);
        pm.deposit(address(fresh), 1);
        vm.stopPrank();

        EpOp memory op = _opFor(address(fresh), _setup(address(fresh), fund, false), ep.getNonce(address(fresh), 0));
        op = _signFor(op, fund, USER_PK);
        (bool ok,,, uint256 charged) = _send(op);
        assertTrue(ok, "setup op runs");
        assertTrue(pm.bootstrapUsed(address(fresh)));
        assertEq(pm.creditOf(address(fresh)), fund + 1 - charged);
    }

    /// PM-2: with gas price caps set, an op signing a priority fee above the cap is refused in validation.
    function test_PM2_gasPriceCaps_refuseHighFeeOps() public {
        _fund(900_000_000);
        uint256 cap = 1 gwei;
        vm.prank(owner);
        pm.setGasPriceCaps(uint128(cap), uint128(cap));

        EpOp memory op = _op(_trade());
        uint256 fee = cap * 50;
        op.gasFees = bytes32((fee << 128) | fee);
        op = _sign(op, 300_000_000, pm.ALLOWANCE_TYPEHASH());
        _mustRevert(op, _aa33(abi.encodeWithSelector(PM.GasPriceAboveCap.selector, fee, fee)));

        // An op inside the caps still goes through.
        EpOp memory ok = _op(_trade());
        ok.gasFees = bytes32((cap << 128) | cap);
        ok = _sign(ok, pm.tokenCost(_gasUnits() * cap, RATE), pm.ALLOWANCE_TYPEHASH());
        (bool success,,,) = _send(ok);
        assertTrue(success);
    }

    function test_PM2_setGasPriceCaps_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pm.setGasPriceCaps(1, 1);
    }
}

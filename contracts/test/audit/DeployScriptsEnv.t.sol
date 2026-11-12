// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymasterTestBase} from "../paymaster/PaymasterTestBase.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployPaymaster} from "../../script/DeployPaymaster.s.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {UsdgDepositNotifier} from "../../src/UsdgDepositNotifier.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {Migration} from "../../src/Migration.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/// @notice Tests of the deploy scripts that configure them through environment variables.
/// @dev vm.setEnv is process-global and test suites run in parallel, so EVERY test that sets env vars read by a
///      deploy script lives in this one sequential test. Two separate suites raced: DeployPaymaster's test set USDG
///      to a mock that only existed in its own EVM, and Deploy.run() in the other suite read it and reverted.
///      Add new env-driven script checks here, not in a new suite.
contract DeployScriptsEnvTest is PaymasterTestBase {
    function setUp() public {
        _setUp(6);
    }

    function test_deployScripts_envConfig() public {
        _deployScriptWiring();
        _deployPaymasterDynamicUnits();
    }

    /// @dev Audit #5 / #10 / #1 / #2 / #12: the local deploy script output is wired correctly.
    function _deployScriptWiring() internal {
        address ur = makeAddr("universalRouter");
        vm.setEnv("UNIVERSAL_ROUTER", vm.toString(ur)); // must be ignored now (SEC-05)
        vm.setEnv("USDG", vm.toString(address(0))); // local deploy: Deploy creates its own mock USDG
        Deploy d = new Deploy();
        Deploy.Out memory o = d.run();

        // #5 deposit notifier wired → onUsdgDeposit reachable
        assertEq(ReferralRegistry(o.referrals).depositHook(), o.depositNotifier);
        assertEq(address(UsdgDepositNotifier(o.depositNotifier).registry()), o.referrals);
        assertEq(address(UsdgDepositNotifier(o.depositNotifier).usdg()), o.usdg);

        // #10 only DiscipleRouter is trusted for hookData attribution
        assertTrue(DiscipleHook(o.hook).isTrustedRouter(o.router));
        assertFalse(DiscipleHook(o.hook).isTrustedRouter(ur));

        // #1 migrate gated by Launchpad registry; #12 hook wired to Migration
        assertEq(Migration(o.migration).launchpad(), o.launchpad);
        assertEq(DiscipleHook(o.hook).migration(), o.migration);

        // #2 hook address carries the beforeInitialize flag
        assertTrue(uint160(o.hook) & Hooks.BEFORE_INITIALIZE_FLAG != 0);
        assertTrue(uint160(o.hook) & Hooks.BEFORE_ADD_LIQUIDITY_FLAG != 0);
    }

    /// @dev DeployPaymaster uses dynamic gas units (PAYMASTER_MAX_GAS_PER_OP), requires an owner-supplied stake,
    ///      keeps no minimum ETH float, and rejects the removed static USDG caps.
    function _deployPaymasterDynamicUnits() internal {
        vm.chainId(46630);
        vm.deal(owner, 1 ether);
        vm.etch(0x0000000071727De22E5E9d8BAf0edAc6f37da032, address(ep).code);
        vm.setEnv("USDG", vm.toString(address(usdg)));
        vm.setEnv("PAYMASTER_OWNER", vm.toString(address(this)));
        vm.setEnv("PAYMASTER_SIGNER", vm.toString(signer));
        vm.setEnv("PAYMASTER_TREASURY", vm.toString(treasury));
        vm.setEnv("PAYMASTER_MIN_RATE", vm.toString(rate / 10));
        vm.setEnv("PAYMASTER_MAX_RATE", vm.toString(rate * 10));
        vm.setEnv("PAYMASTER_MAX_COST", "0");
        vm.setEnv("PAYMASTER_MAX_COST_USDG", "0");
        vm.setEnv("PAYMASTER_DEPOSIT_WEI", "0");
        vm.setEnv("PAYMASTER_STAKE_WEI", "1"); // unit-test fixture only

        DeployPaymaster d = new DeployPaymaster();
        vm.setEnv("PAYMASTER_MAX_GAS_PER_OP", "2000000");
        DisciplePaymaster deployed = d.run();
        assertEq(deployed.maxGasPerOp(), 2_000_000);
        assertEq(deployed.getDeposit(), 0, "no minimum ETH float");
        vm.setEnv("PAYMASTER_STAKE_WEI", "0");
        vm.expectRevert(bytes("owner must supply PAYMASTER_STAKE_WEI (~$5 of ETH)"));
        d.run();
        vm.setEnv("PAYMASTER_STAKE_WEI", "1");
        vm.setEnv("PAYMASTER_MAX_COST_USDG", "10");
        vm.expectRevert(bytes("static USDG caps removed: use PAYMASTER_MAX_GAS_PER_OP"));
        d.run();
        vm.setEnv("PAYMASTER_MAX_COST_USDG", "0");
    }
}

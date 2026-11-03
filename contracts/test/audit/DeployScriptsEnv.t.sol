// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymasterTestBase} from "../paymaster/PaymasterTestBase.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployPaymaster} from "../../script/DeployPaymaster.s.sol";
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
        _deployPaymasterWholeUsdg();
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

    /// @dev DeployPaymaster takes WHOLE USDG (PAYMASTER_MAX_COST_USDG), scaled by decimals, bounded to [0.1, 100] USDG.
    function _deployPaymasterWholeUsdg() internal {
        vm.chainId(46630);
        vm.setEnv("USDG", vm.toString(address(usdg)));
        vm.setEnv("PAYMASTER_OWNER", vm.toString(owner));
        vm.setEnv("PAYMASTER_SIGNER", vm.toString(signer));
        vm.setEnv("PAYMASTER_TREASURY", vm.toString(treasury));
        vm.setEnv("PAYMASTER_MIN_RATE", vm.toString(rate / 10));
        vm.setEnv("PAYMASTER_MAX_RATE", vm.toString(rate * 10));
        vm.setEnv("PAYMASTER_MAX_COST", "0");
        vm.setEnv("PAYMASTER_DEPOSIT_WEI", "0");
        vm.setEnv("PAYMASTER_STAKE_WEI", "0");

        DeployPaymaster d = new DeployPaymaster();
        vm.setEnv("PAYMASTER_MAX_COST_USDG", "2");
        assertEq(d.run().maxCostCap(), 2 * 10 ** 6); // testnet runbook value: 2 USDG == 2000000 raw

        vm.setEnv("PAYMASTER_MAX_COST_USDG", "100");
        assertEq(d.run().maxCostCap(), 100 * 10 ** 6);

        vm.setEnv("PAYMASTER_MAX_COST_USDG", "0");
        vm.expectRevert(bytes("PAYMASTER_MAX_COST_USDG outside [0.1, 100] USDG"));
        d.run();

        vm.setEnv("PAYMASTER_MAX_COST_USDG", "101");
        vm.expectRevert(bytes("PAYMASTER_MAX_COST_USDG outside [0.1, 100] USDG"));
        d.run();

        vm.setEnv("PAYMASTER_MAX_COST_USDG", "2");
        vm.setEnv("PAYMASTER_MAX_COST", "2000000");
        vm.expectRevert(bytes("PAYMASTER_MAX_COST (raw) removed: use PAYMASTER_MAX_COST_USDG"));
        d.run();
        vm.setEnv("PAYMASTER_MAX_COST", "0");
    }
}

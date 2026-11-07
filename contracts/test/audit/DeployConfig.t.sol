// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy, DevToken} from "../../script/Deploy.s.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {UsdgDepositNotifier} from "../../src/UsdgDepositNotifier.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {Migration} from "../../src/Migration.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/// @notice Audit #5 / #10 / #1 / #2 / #12: the local deploy script output is wired correctly.
contract DeployConfigTest is Test {
    function test_deployScriptRejectsHooklessReferenceSource() public {
        // The script's unconfigured local STRATEGY/USDG source is hookless: never pretend it has source history.
        vm.setEnv("USDG", vm.toString(address(0)));
        vm.setEnv("DEFAULT_QUOTE", vm.toString(address(0)));
        vm.setEnv("DEPLOY_TEST_STRATEGY", "false");
        Deploy d = new Deploy();
        vm.expectPartialRevert(QuotePricer.NoSourceHistory.selector);
        d.run();
        vm.stopBroadcast();
    }

    function test_deployScriptWiring() public {
        // Keep every wiring assertion with a local USDG-only fixture ($1 by definition, no external source).
        // This is not a production pool selection or a change to the deploy script/config.
        DevToken usdg = new DevToken("USDG fixture", "USDG", 6, address(this), 1e18);
        vm.setEnv("USDG", vm.toString(address(usdg)));
        vm.setEnv("DEFAULT_QUOTE", vm.toString(address(usdg)));
        address ur = makeAddr("universalRouter");
        vm.setEnv("UNIVERSAL_ROUTER", vm.toString(ur)); // must be ignored now (SEC-05)
        Deploy d = new Deploy();
        Deploy.Out memory o = d.run();
        vm.setEnv("USDG", vm.toString(address(0)));
        vm.setEnv("DEFAULT_QUOTE", vm.toString(address(0)));
        assertEq(o.defaultQuote, address(usdg));
        assertEq(o.usdg, address(usdg));
        // Price is USD WAD per 1e18 raw units: 6-decimal USDG uses 1e30.
        assertEq(QuotePricer(o.pricer).quotePriceUsd(o.defaultQuote), 1e30);

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
}

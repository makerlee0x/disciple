// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {UsdgDepositNotifier} from "../../src/UsdgDepositNotifier.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {Migration} from "../../src/Migration.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/// @notice Audit #5 / #10 / #1 / #2 / #12: the local deploy script output is wired correctly.
contract DeployConfigTest is Test {
    function test_deployScriptWiring() public {
        address ur = makeAddr("universalRouter");
        vm.setEnv("UNIVERSAL_ROUTER", vm.toString(ur)); // must be ignored now (SEC-05)
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
}

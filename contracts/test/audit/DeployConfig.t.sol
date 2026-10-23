// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {UsdgDepositNotifier} from "../../src/UsdgDepositNotifier.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {Migration} from "../../src/Migration.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev The redeploy's USDG6=1 mode (MOCK_USDG_DECIMALS=6), pinned without touching process env.
contract Deploy6Dec is Deploy {
    function _mockUsdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}

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

    /// @notice USDG6=1 redeploy mode: 6-dec mock USDG minted to the deployer, decimal-scaled gate, ref pool and price.
    function test_deployScript6DecMockUsdg() public {
        Deploy.Out memory o = new Deploy6Dec().run();
        assertEq(IERC20Metadata(o.usdg).decimals(), 6, "mock USDG is 6-dec");
        assertEq(ReferralRegistry(o.referrals).usdgGate(), 10e6, "$10 gate in 6-dec raw");
        assertEq(QuotePricer(o.pricer).usdgDecimals(), 6);
        // STRATEGY seeded at $0.00245 (USD WAD per 1e18 raw), not 1e12x off from an 18-dec raw price default
        assertApproxEqRel(QuotePricer(o.pricer).quotePriceUsd(o.defaultQuote), 245e13, 0.01e18, "STRATEGY ~$0.00245");
        assertTrue(o.defaultQuote != o.usdg, "mock STRATEGY deployed");
    }

    function test_deployScript18DecDefaultsUnchanged() public {
        Deploy.Out memory o = new Deploy().run();
        assertEq(IERC20Metadata(o.usdg).decimals(), 18);
        assertEq(ReferralRegistry(o.referrals).usdgGate(), 10e18);
        assertApproxEqRel(QuotePricer(o.pricer).quotePriceUsd(o.defaultQuote), 245e13, 0.01e18);
    }
}

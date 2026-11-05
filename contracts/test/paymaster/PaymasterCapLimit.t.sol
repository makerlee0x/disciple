// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymasterTestBase, MockUSDG} from "./PaymasterTestBase.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {DeployPaymaster} from "../../script/DeployPaymaster.s.sol";

/// @notice AUDIT Info (2026-10-24): maxCostCap has a sanity ceiling (100 USDG at the token's decimals).
contract PaymasterCapLimitTest is PaymasterTestBase {
    function setUp() public virtual {
        _setUp(18);
    }

    function test_limit_is100Usdg() public view {
        assertEq(pm.MAX_COST_CAP_LIMIT_USDG(), 100);
        assertEq(pm.maxCostCapLimit(), 100 * 10 ** dec);
    }

    function test_setBounds_atLimit_ok_aboveLimit_reverts() public {
        uint256 lim = 100 * 10 ** dec;
        vm.startPrank(owner);
        pm.setBounds(rate / 10, rate * 10, lim);
        assertEq(pm.maxCostCap(), lim);
        vm.expectRevert(abi.encodeWithSelector(DisciplePaymaster.MaxCostCapAboveLimit.selector, lim + 1, lim));
        pm.setBounds(rate / 10, rate * 10, lim + 1);
        vm.expectRevert(abi.encodeWithSelector(DisciplePaymaster.MaxCostCapAboveLimit.selector, type(uint256).max, lim));
        pm.setBounds(rate / 10, rate * 10, type(uint256).max);
        vm.stopPrank();
        assertEq(pm.maxCostCap(), lim);
    }

    function test_constructor_aboveLimit_reverts() public {
        uint256 lim = 100 * 10 ** dec;
        vm.expectRevert(abi.encodeWithSelector(DisciplePaymaster.MaxCostCapAboveLimit.selector, lim + 1, lim));
        new DisciplePaymaster(address(ep), address(usdg), owner, signer, treasury, rate / 10, rate * 10, lim + 1, 30_000);
    }
}

contract PaymasterCapLimit6DecTest is PaymasterCapLimitTest {
    function setUp() public override {
        _setUp(6);
    }
}

/// @notice DeployPaymaster takes WHOLE USDG (PAYMASTER_MAX_COST_USDG), scaled by decimals, bounded to [0.1, 100] USDG.
contract DeployPaymasterEnvTest is PaymasterTestBase {
    function setUp() public {
        _setUp(6);
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
    }

    /// @dev one sequential test: vm.setEnv is process-global and suites run in parallel.
    function test_deployScript_wholeUsdg_bounds_and_rawEnvRejected() public {
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

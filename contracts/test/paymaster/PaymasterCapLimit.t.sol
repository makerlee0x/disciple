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

/// @notice Old deployment/funding instructions fail closed on every chain.
contract DeployPaymasterEnvTest is PaymasterTestBase {
    function test_deploymentDisabledOnEveryChain() public {
        DeployPaymaster d = new DeployPaymaster();
        uint256[3] memory chains = [uint256(1), uint256(46630), uint256(31337)];
        for (uint256 i; i < chains.length; i++) {
            vm.chainId(chains[i]);
            vm.expectRevert(bytes("gas sponsorship disabled"));
            d.run();
        }
    }
}

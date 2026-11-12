// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {PaymasterTestBase} from "./PaymasterTestBase.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {DeployPaymaster} from "../../script/DeployPaymaster.s.sol";
contract PaymasterCapLimitTest is PaymasterTestBase {
    function setUp() public virtual { _setUp(18); }
    function test_launchDefaultIsTwiceWorstMeasuredEntryPointGas() public {
        assertEq(new DeployPaymaster().DEFAULT_MAX_LAUNCH_GAS_PER_OP(), 2 * 10_927_979);
    }

    function test_dynamicGasUnitLimit_independentOfDecimals() public {
        vm.prank(owner); pm.setBounds(rate / 10, rate * 10, 2_000_000);
        assertEq(pm.maxGasPerOp(), 2_000_000);
        assertEq(pm.tokenCost(pm.maxGasPerOp() * 2 gwei, rate), 2 * pm.tokenCost(pm.maxGasPerOp() * 1 gwei, rate));
    }
    function test_zeroGasLimit_reverts() public {
        vm.prank(owner); vm.expectRevert(DisciplePaymaster.InvalidBounds.selector);
        pm.setBounds(rate / 10, rate * 10, 0);
    }
}
contract PaymasterCapLimit6DecTest is PaymasterCapLimitTest {
    function setUp() public override { _setUp(6); }
}
contract DeployPaymasterEnvTest is PaymasterTestBase {
    function setUp() public {
        _setUp(6); vm.chainId(46630); vm.deal(owner, 1 ether);
        vm.etch(0x0000000071727De22E5E9d8BAf0edAc6f37da032, address(ep).code);
        vm.setEnv("USDG", vm.toString(address(usdg)));
        vm.setEnv("PAYMASTER_OWNER", vm.toString(address(this)));
        vm.setEnv("PAYMASTER_SIGNER", vm.toString(signer));
        vm.setEnv("PAYMASTER_TREASURY", vm.toString(treasury));
        vm.setEnv("PAYMASTER_MIN_RATE", vm.toString(rate / 10));
        vm.setEnv("PAYMASTER_MAX_RATE", vm.toString(rate * 10));
        vm.setEnv("PAYMASTER_MAX_COST", "0"); vm.setEnv("PAYMASTER_MAX_COST_USDG", "0");
        vm.setEnv("PAYMASTER_DEPOSIT_WEI", "0"); vm.setEnv("PAYMASTER_STAKE_WEI", "1"); // unit-test fixture only
    }
    function test_deployScript_dynamicUnits_requiredStake_noMinimumFloat() public {
        DeployPaymaster d = new DeployPaymaster();
        vm.setEnv("PAYMASTER_MAX_GAS_PER_OP", "2000000");
        DisciplePaymaster deployed = d.run();
        assertEq(deployed.maxGasPerOp(), 2_000_000);
        assertEq(deployed.getDeposit(), 0, "no minimum ETH float");
        vm.setEnv("PAYMASTER_STAKE_WEI", "0");
        vm.expectRevert(bytes("owner must supply PAYMASTER_STAKE_WEI (~$5 of ETH)")); d.run();
        vm.setEnv("PAYMASTER_STAKE_WEI", "1"); vm.setEnv("PAYMASTER_MAX_COST_USDG", "10");
        vm.expectRevert(bytes("static USDG caps removed: use PAYMASTER_MAX_GAS_PER_OP")); d.run();
        vm.setEnv("PAYMASTER_MAX_COST_USDG", "0");
    }
}

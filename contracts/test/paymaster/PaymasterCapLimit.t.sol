// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {PaymasterTestBase} from "./PaymasterTestBase.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {DeployPaymaster} from "../../script/DeployPaymaster.s.sol";
contract PaymasterCapLimitTest is PaymasterTestBase {
    function setUp() public virtual { _setUp(18); }
    function test_launchDefaultIsTwiceWorstMeasuredEntryPointGas() public {
        assertEq(new DeployPaymaster().DEFAULT_MAX_LAUNCH_GAS_PER_OP(), 2 * 10_920_385);
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

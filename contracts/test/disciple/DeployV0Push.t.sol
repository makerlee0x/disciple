// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployV0Push} from "../../script/disciple/DeployV0Push.s.sol";

/// @notice maker's rule (2026-11-04): nothing deploys on Ethereum until the audit. Both Ethereum steps refuse
///         without AUDITED=1.
contract DeployV0PushGateTest is Test {
    function test_ethereumStepsWaitForTheAudit() public {
        vm.setEnv("AUDITED", "0");
        vm.chainId(1);
        DeployV0Push d = new DeployV0Push();
        vm.expectRevert(bytes("Ethereum deploys wait for the audit"));
        d.sender();
        vm.expectRevert(bytes("Ethereum deploys wait for the audit"));
        d.ethereum();
    }
}

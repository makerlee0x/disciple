// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DiscipleSessionPolicyV144} from "../src/session/DiscipleSessionPolicyV144.sol";

/// @notice Deploys session policy 1.4.4 (audit 2026-11-14 SK-1/SK-2) bound to the v5 gas-credit paymaster. No owner, no admin.
///         env: REFERRAL_REGISTRY, PAYMASTER (REQUIRED: the DisciplePaymasterV5 address). NOT RUN in the PR.
///         forge script script/DeploySessionPolicyV144.s.sol --rpc-url <rpc> --broadcast
contract DeploySessionPolicyV144 is Script {
    function run() external returns (DiscipleSessionPolicyV144 p) {
        require(block.chainid == 46630 || block.chainid == 4663, "Robinhood Chain only");
        address registry = vm.envAddress("REFERRAL_REGISTRY");
        address paymaster = vm.envAddress("PAYMASTER");
        require(paymaster.code.length != 0, "PAYMASTER must be the deployed v5");
        vm.startBroadcast();
        p = new DiscipleSessionPolicyV144(registry, paymaster);
        vm.stopBroadcast();
        console2.log("DiscipleSessionPolicyV144", address(p));
        console2.log("paymaster", paymaster);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DiscipleSessionPolicy} from "../src/session/DiscipleSessionPolicy.sol";

/// @notice Deploys the stateless-config DiscipleSessionPolicy hook module (no owner, no admin).
///         Constructor args: the DISCIPLE ReferralRegistry (env REFERRAL_REGISTRY) for P_REFERRAL / tryAttribute, and
///         the DISCIPLE USDG paymaster (env PAYMASTER, optional; address(0) = no paymaster approvals) — policy 1.4.1.
///         forge script script/DeploySessionPolicy.s.sol --rpc-url robinhood --broadcast
contract DeploySessionPolicy is Script {
    function run() external returns (DiscipleSessionPolicy p) {
        address registry = vm.envAddress("REFERRAL_REGISTRY");
        address paymaster = vm.envOr("PAYMASTER", address(0));
        vm.startBroadcast();
        p = new DiscipleSessionPolicy(registry, paymaster);
        vm.stopBroadcast();
        console2.log("DiscipleSessionPolicy", address(p));
        console2.log("paymaster", paymaster);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DiscipleSessionPolicy} from "../src/session/DiscipleSessionPolicy.sol";

/// @notice Deploys the stateless-config DiscipleSessionPolicy hook module (no owner, no admin).
///         Constructor args: the DISCIPLE ReferralRegistry (env REFERRAL_REGISTRY) for P_REFERRAL / tryAttribute, and
///         no paymaster approvals (sponsorship disabled on every chain) — policy 1.4.1.
///         forge script script/DeploySessionPolicy.s.sol --rpc-url robinhood --broadcast
contract DeploySessionPolicy is Script {
    function run() external returns (DiscipleSessionPolicy p) {
        address registry = vm.envAddress("REFERRAL_REGISTRY");
        address paymaster = address(0); // Never enable sponsorship via stale PAYMASTER env.
        vm.startBroadcast();
        p = new DiscipleSessionPolicy(registry, paymaster);
        vm.stopBroadcast();
        console2.log("DiscipleSessionPolicy", address(p));
        console2.log("paymaster", paymaster);
    }
}

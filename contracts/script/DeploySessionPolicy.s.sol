// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DiscipleSessionPolicy} from "../src/session/DiscipleSessionPolicy.sol";

/// @notice Deploys the stateless-config DiscipleSessionPolicy hook module (no owner, no admin).
///         Constructor arg: the DISCIPLE ReferralRegistry (env REFERRAL_REGISTRY) for P_REFERRAL / tryAttribute.
///         forge script script/DeploySessionPolicy.s.sol --rpc-url robinhood --broadcast
contract DeploySessionPolicy is Script {
    function run() external returns (DiscipleSessionPolicy p) {
        address registry = vm.envAddress("REFERRAL_REGISTRY");
        vm.startBroadcast();
        p = new DiscipleSessionPolicy(registry);
        vm.stopBroadcast();
        console2.log("DiscipleSessionPolicy", address(p));
    }
}

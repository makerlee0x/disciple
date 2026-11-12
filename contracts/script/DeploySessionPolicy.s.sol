// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NetworkConfig} from "./config/NetworkConfig.sol";
import {DiscipleSessionPolicy} from "../src/session/DiscipleSessionPolicy.sol";

/// @notice Deploys the stateless-config DiscipleSessionPolicy hook module (no owner, no admin).
///         Constructor args: the DISCIPLE ReferralRegistry (env REFERRAL_REGISTRY) for P_REFERRAL / tryAttribute, and
///         the DISCIPLE USDG paymaster (env PAYMASTER, optional; address(0) = no paymaster approvals) — policy 1.4.2 (prepaid gas accounting).
///         forge script script/DeploySessionPolicy.s.sol --rpc-url robinhood --broadcast
contract DeploySessionPolicy is NetworkConfig {
    function run() external returns (DiscipleSessionPolicy p) {
        bool mainnet = _checkNetwork();
        address registry = mainnet ? _requiredContract("REFERRAL_REGISTRY") : vm.envAddress("REFERRAL_REGISTRY");
        address paymaster = vm.envOr("PAYMASTER", address(0));
        vm.startBroadcast();
        p = new DiscipleSessionPolicy(registry, paymaster);
        vm.stopBroadcast();
        console2.log("DiscipleSessionPolicy", address(p));
        console2.log("paymaster", paymaster);
    }
}

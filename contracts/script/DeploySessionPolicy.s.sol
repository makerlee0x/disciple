// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DiscipleSessionPolicy} from "../src/session/DiscipleSessionPolicy.sol";

/// @notice Deploys the stateless-config DiscipleSessionPolicy hook module (no owner, no admin, no constructor args).
///         forge script script/DeploySessionPolicy.s.sol --rpc-url robinhood --broadcast   (NOT run in this PR)
contract DeploySessionPolicy is Script {
    function run() external returns (DiscipleSessionPolicy p) {
        vm.startBroadcast();
        p = new DiscipleSessionPolicy();
        vm.stopBroadcast();
        console2.log("DiscipleSessionPolicy", address(p));
    }
}

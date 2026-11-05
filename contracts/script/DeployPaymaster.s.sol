// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {DisciplePaymaster} from "../src/paymaster/DisciplePaymaster.sol";

/// @notice Historical entry point retained to fail closed for old runbooks.
/// No deployment, deposit, stake, env reads, or broadcast: all chains are self-paid.
contract DeployPaymaster is Script {
    function run() external pure returns (DisciplePaymaster) {
        revert("gas sponsorship disabled");
    }
}

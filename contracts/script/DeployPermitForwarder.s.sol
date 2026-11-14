// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {NetworkConfig} from "./config/NetworkConfig.sol";
import {DisciplePermitForwarder} from "../src/addons/DisciplePermitForwarder.sol";

/// @notice Deploys DisciplePermitForwarder (no owner, no admin, no constructor args) with CREATE2 through the standard
///         deterministic deployer, so it lands on the SAME address on Robinhood testnet (46630) and mainnet (4663).
///         Then set NEXT_PUBLIC_RHT_PERMIT_FORWARDER / NEXT_PUBLIC_RH_PERMIT_FORWARDER in Vercel: the gasless relays switch from
///         the public Multicall3 to it (web/lib/trade/permitForwarder relaySpender). Mainnet relays refuse until it is set.
///         Dry run:  forge script script/DeployPermitForwarder.s.sol --rpc-url robinhood_testnet
///         Deploy:   forge script script/DeployPermitForwarder.s.sol --rpc-url robinhood_testnet --broadcast
contract DeployPermitForwarder is NetworkConfig {
    bytes32 constant SALT = keccak256("DISCIPLE.DisciplePermitForwarder.v1");

    function run() external returns (DisciplePermitForwarder f) {
        _checkNetwork();
        vm.startBroadcast();
        f = new DisciplePermitForwarder{salt: SALT}();
        vm.stopBroadcast();
        console2.log("DisciplePermitForwarder", address(f));
        console2.log("PERMIT2", f.PERMIT2());
    }
}

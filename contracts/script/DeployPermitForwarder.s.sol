// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {NetworkConfig} from "./config/NetworkConfig.sol";
import {DisciplePermitForwarder} from "../src/addons/DisciplePermitForwarder.sol";

/// @notice Deploys DisciplePermitForwarder (no owner, no admin, no constructor args) with CREATE2 through the standard
///         deterministic deployer. The address follows the exact bytecode, which includes the compiler's metadata hash
///         (source paths, settings), so it only matches across chains when the SAME build deploys both: use the address this
///         script prints. Testnet (46630): 0x18c2375C08b992B704124c2D37151a27d81e7c55 (2026-11-14, deployments/rh-testnet-46630.json).
///         Then set NEXT_PUBLIC_RHT_PERMIT_FORWARDER / NEXT_PUBLIC_RH_PERMIT_FORWARDER (or the default in web/lib/chains.ts): the
///         gasless relays switch from the public Multicall3 to it (web/lib/trade/permitForwarder relaySpender). Mainnet relays
///         refuse until it is set.
///         Dry run:  forge script script/DeployPermitForwarder.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com
///         Deploy:   forge script script/DeployPermitForwarder.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast <signer flags>
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

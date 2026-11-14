// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {GaslessForwarder} from "../../src/addons/GaslessForwarder.sol";

/// @notice Deploys GaslessForwarder, the Permit2 spender for gasless withdrawals, action fees and private launches.
///         No constructor args, no owner, no wiring on-chain: only the web env changes afterwards
///         (NEXT_PUBLIC_RHT_GASLESS_FORWARDER on testnet, NEXT_PUBLIC_RH_GASLESS_FORWARDER on mainnet).
///         forge script script/gasless/DeployGaslessForwarder.s.sol --rpc-url $RPC_URL [--broadcast]
contract DeployGaslessForwarder is Script {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external returns (GaslessForwarder f) {
        require(block.chainid == 46630 || block.chainid == 4663 || block.chainid == 31337, "unknown chain");
        require(PERMIT2.code.length > 0, "Permit2 is not deployed on this chain");
        vm.startBroadcast();
        f = new GaslessForwarder();
        vm.stopBroadcast();
        require(address(f.PERMIT2()) == PERMIT2, "permit2");
        console2.log("GaslessForwarder", address(f));
        console2.log("chain", block.chainid);
    }
}

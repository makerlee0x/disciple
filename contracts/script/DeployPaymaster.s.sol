// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DisciplePaymaster} from "../src/paymaster/DisciplePaymaster.sol";

/// @notice Deploys DisciplePaymaster (USDG token paymaster, EntryPoint v0.7). RH TESTNET ONLY until review.
///         NOT RUN in the PR — deploy happens after review.
///         env: USDG, PAYMASTER_OWNER, PAYMASTER_SIGNER (address only — never the key), PAYMASTER_TREASURY,
///              PAYMASTER_MIN_RATE / PAYMASTER_MAX_RATE (USDG raw units per 1 ETH), PAYMASTER_MAX_COST (USDG raw),
///              PAYMASTER_DEPOSIT_WEI, PAYMASTER_STAKE_WEI (owner-broadcast only), PAYMASTER_POST_OP_GAS (default 30k)
///         forge script script/DeployPaymaster.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast
contract DeployPaymaster is Script {
    address constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external returns (DisciplePaymaster pm) {
        require(block.chainid == 46630, "RH testnet only");
        address owner = vm.envAddress("PAYMASTER_OWNER");
        vm.startBroadcast();
        pm = new DisciplePaymaster(
            ENTRYPOINT_V07,
            vm.envAddress("USDG"),
            owner,
            vm.envAddress("PAYMASTER_SIGNER"),
            vm.envAddress("PAYMASTER_TREASURY"),
            vm.envUint("PAYMASTER_MIN_RATE"),
            vm.envUint("PAYMASTER_MAX_RATE"),
            vm.envUint("PAYMASTER_MAX_COST"),
            vm.envOr("PAYMASTER_POST_OP_GAS", uint256(30_000))
        );
        uint256 dep = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(0));
        if (dep != 0) pm.deposit{value: dep}();
        uint256 stake = vm.envOr("PAYMASTER_STAKE_WEI", uint256(0));
        if (stake != 0 && msg.sender == owner) pm.addStake{value: stake}(1 days); // ERC-7562: context needs a staked paymaster
        vm.stopBroadcast();
        console2.log("DisciplePaymaster", address(pm));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DisciplePaymaster} from "../src/paymaster/DisciplePaymaster.sol";

/// @notice Deploys DisciplePaymaster (USDG token paymaster, EntryPoint v0.7). RH TESTNET ONLY until review.
///         NOT RUN in the PR — deploy happens after review.
///         env: USDG, PAYMASTER_OWNER, PAYMASTER_SIGNER (address only — never the key), PAYMASTER_TREASURY,
///              PAYMASTER_MIN_RATE / PAYMASTER_MAX_RATE (USDG raw units per 1 ETH),
///              PAYMASTER_MAX_GAS_PER_OP / PAYMASTER_MAX_LAUNCH_GAS_PER_OP (gas UNITS),
///              PAYMASTER_STAKE_WEI (REQUIRED: ~$5 of ETH at operator deploy-time ETH/USD price),
///              PAYMASTER_DEPOSIT_WEI (optional, default 0; tiny float allowed), PAYMASTER_POST_OP_GAS.
///         No automatic keeper. No gas-rate markup.
///         forge script script/DeployPaymaster.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast
contract DeployPaymaster is Script {
    address constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    // Defaults updated from real EntryPoint runtime measurements (gas UNITS, never a fixed USDG amount).
    uint256 public constant DEFAULT_MAX_GAS_PER_OP = 7_068_712;
    uint256 public constant DEFAULT_MAX_LAUNCH_GAS_PER_OP = 21_840_770; // 2x worst real EntryPoint launch actualGasUsed: 10,920,385
    uint256 public constant DEFAULT_POST_OP_GAS = 79_684;

    function run() external returns (DisciplePaymaster pm) {
        require(block.chainid == 46630, "RH testnet only");
        address owner = vm.envAddress("PAYMASTER_OWNER");
        address usdg = vm.envAddress("USDG");
        require(msg.sender == owner, "owner must deploy and stake");
        uint256 stake = vm.envUint("PAYMASTER_STAKE_WEI"); // REQUIRED: ~$5 of ETH at operator-supplied deploy-time price; NOT a confirmed Alchemy minimum
        require(stake > 0, "owner must supply PAYMASTER_STAKE_WEI (~$5 of ETH)");
        require(
            vm.envOr("PAYMASTER_MAX_COST", uint256(0)) == 0 && vm.envOr("PAYMASTER_MAX_COST_USDG", uint256(0)) == 0,
            "static USDG caps removed: use PAYMASTER_MAX_GAS_PER_OP"
        );
        uint256 maxGas = vm.envOr("PAYMASTER_MAX_GAS_PER_OP", DEFAULT_MAX_GAS_PER_OP);
        vm.startBroadcast(owner);
        pm = new DisciplePaymaster(
            ENTRYPOINT_V07,
            usdg,
            owner,
            vm.envAddress("PAYMASTER_SIGNER"),
            vm.envAddress("PAYMASTER_TREASURY"),
            vm.envUint("PAYMASTER_MIN_RATE"),
            vm.envUint("PAYMASTER_MAX_RATE"),
            maxGas,
            vm.envOr("PAYMASTER_POST_OP_GAS", DEFAULT_POST_OP_GAS)
        );
        pm.setLaunchGasLimit(vm.envOr("PAYMASTER_MAX_LAUNCH_GAS_PER_OP", DEFAULT_MAX_LAUNCH_GAS_PER_OP));
        uint256 dep = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(0));
        if (dep != 0) pm.deposit{value: dep}();
        pm.addStake{value: stake}(1 days); // ERC-7562: context needs a staked paymaster
        vm.stopBroadcast();
        console2.log("DisciplePaymaster", address(pm));
        console2.log("maxGasPerOp (gas units; dynamic USDG max at signed fee and rate)", maxGas);
    }
}

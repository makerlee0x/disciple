// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DisciplePaymasterV5} from "../src/paymaster/DisciplePaymasterV5.sol";

/// @notice Deploys DisciplePaymasterV5 (hidden USDG gas credit, EntryPoint v0.7), sets the launch gas cap,
///         optionally funds the ETH float, and stakes it (ERC-7562: the credit ledger needs a staked paymaster).
///         One path for RH testnet (46630) and RH mainnet (4663). NOT RUN in the PR; deploy only with lee's OK.
///         env: USDG, PAYMASTER_OWNER (must be the broadcaster), PAYMASTER_SIGNER (address only, never the key),
///              PAYMASTER_TREASURY, PAYMASTER_MIN_RATE / PAYMASTER_MAX_RATE (USDG raw units per 1 ETH),
///              PAYMASTER_STAKE_WEI (REQUIRED, ~$5 of ETH), PAYMASTER_DEPOSIT_WEI (optional float),
///              optional: PAYMASTER_MAX_GAS_PER_OP, PAYMASTER_MAX_LAUNCH_GAS_PER_OP, PAYMASTER_POST_OP_GAS,
///              PAYMASTER_UNSTAKE_DELAY_SEC (default 1 day).
///         forge script script/DeployPaymasterV5.s.sol --rpc-url <rpc> --broadcast
contract DeployPaymasterV5 is Script {
    address constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    // Same measured gas-unit defaults as the v4 deploy (2x worst real EntryPoint runs; never a fixed USDG amount).
    uint256 public constant DEFAULT_MAX_GAS_PER_OP = 7_068_712;
    uint256 public constant DEFAULT_MAX_LAUNCH_GAS_PER_OP = 21_840_770;
    uint256 public constant DEFAULT_POST_OP_GAS = 150_000; // must match web readiness guard (>= 150k)

    function run() external returns (DisciplePaymasterV5 pm) {
        require(block.chainid == 46630 || block.chainid == 4663, "Robinhood Chain only");
        address owner = vm.envAddress("PAYMASTER_OWNER");
        require(msg.sender == owner, "owner must deploy and stake");
        uint256 stake = vm.envUint("PAYMASTER_STAKE_WEI");
        require(stake > 0, "owner must supply PAYMASTER_STAKE_WEI (~$5 of ETH)");
        uint256 maxGas = vm.envOr("PAYMASTER_MAX_GAS_PER_OP", DEFAULT_MAX_GAS_PER_OP);
        uint32 delay = uint32(vm.envOr("PAYMASTER_UNSTAKE_DELAY_SEC", uint256(1 days)));
        vm.startBroadcast(owner);
        pm = new DisciplePaymasterV5(
            ENTRYPOINT_V07,
            vm.envAddress("USDG"),
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
        pm.addStake{value: stake}(delay);
        vm.stopBroadcast();
        console2.log("DisciplePaymasterV5", address(pm));
        console2.log("maxGasPerOp (gas units)", maxGas);
    }
}

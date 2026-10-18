// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";

/// @notice Standalone AnonLauncher v2 deploy (claims pay the post-grad launch-token creator share too).
///         Copies every constructor arg/config from the live v1 (env ANON_V1) so v2 is a drop-in:
///         launchpad, feeRouter, feeToken (USDG), treasury, announcer, launchFee, owner.
/// @dev No other contract needs to know the AnonLauncher address: Launchpad.launch / FeeRouter are permissionless
///      for it (the AnonLauncher simply becomes the coin creator) and DiscipleSessionPolicy takes `anonLauncher`
///      per session at onInstall. So there is no on-chain wiring; only off-chain config (web/indexer) changes.
///      forge script script/anon/DeployAnonLauncherV2.s.sol --rpc-url $RPC_URL [--broadcast]
contract DeployAnonLauncherV2 is Script {
    function run() external returns (AnonLauncher v2) {
        AnonLauncher v1 = AnonLauncher(vm.envOr("ANON_V1", address(0xE564900809746B1F2bacA9D2b8dF3224a463f359)));
        address owner_ = v1.owner();
        address launchpad_ = address(v1.launchpad());
        address feeRouter_ = address(v1.feeRouter());
        address feeToken_ = address(v1.feeToken());
        address treasury_ = v1.treasury();
        address announcer_ = address(v1.announcer());
        uint256 launchFee_ = v1.launchFee();

        vm.startBroadcast();
        v2 = new AnonLauncher(owner_, launchpad_, feeRouter_, feeToken_, treasury_, announcer_, launchFee_);
        vm.stopBroadcast();

        require(v2.owner() == owner_, "owner");
        require(address(v2.launchpad()) == launchpad_, "launchpad");
        require(address(v2.feeRouter()) == feeRouter_, "feeRouter");
        require(address(v2.feeToken()) == feeToken_, "feeToken");
        require(v2.treasury() == treasury_, "treasury");
        require(address(v2.announcer()) == announcer_, "announcer");
        require(v2.launchFee() == launchFee_, "launchFee");

        console2.log("AnonLauncher v1 (legacy)", address(v1));
        console2.log("AnonLauncher v2", address(v2));
        console2.log("owner", owner_);
        console2.log("launchpad", launchpad_);
        console2.log("feeRouter", feeRouter_);
        console2.log("feeToken", feeToken_);
        console2.log("treasury", treasury_);
        console2.log("announcer", announcer_);
        console2.log("launchFee", launchFee_);
    }
}

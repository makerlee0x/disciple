// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AnonLaunchPool} from "../../src/addons/AnonLaunchPool.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";

/// @notice Deploys AnonLaunchPool next to an existing AnonLauncher (no change to the core stack or the launcher).
///         Env:
///           ANON_LAUNCHER   AnonLauncher (required)
///           HARVEST         CreatorFeeHarvest for pool / burn fee routing (0 = keep only)
///           POOL_OWNER      the Safe (required on mainnet 4663)
///           SPEND_SIGNER    the site's spend key address (ANON_POOL_SIGNER_KEY in Vercel)
///           DAILY_LIMIT     max USDG out per UTC day, raw units (default 5,000 USDG at 6 decimals)
///         Then set NEXT_PUBLIC_RH_ANON_POOL (or _RHT_) and flip lib/anonPool ANON_POOL_LIVE.
///         forge script script/anon/DeployAnonLaunchPool.s.sol --rpc-url <rpc> --broadcast <signer>
contract DeployAnonLaunchPool is Script {
    function run() external returns (AnonLaunchPool pool) {
        AnonLauncher anon = AnonLauncher(vm.envAddress("ANON_LAUNCHER"));
        address harvest = vm.envOr("HARVEST", address(0));
        address owner_ = vm.envOr("POOL_OWNER", msg.sender);
        if (block.chainid == 4663) {
            require(owner_ != msg.sender && owner_.code.length > 0, "mainnet: owner must be the Safe");
        }
        address signer = vm.envAddress("SPEND_SIGNER");
        uint256 limit = vm.envOr("DAILY_LIMIT", uint256(5_000e6));
        require(harvest == address(0) || anon.creatorFeeHarvest() == harvest, "harvest is not the launcher's");

        vm.startBroadcast();
        pool = new AnonLaunchPool(owner_, address(anon.feeToken()), address(anon), harvest, signer, limit);
        vm.stopBroadcast();

        require(pool.spendSigner() == signer && pool.owner() == owner_, "verify");
        console2.log("AnonLaunchPool", address(pool));
    }
}

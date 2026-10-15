// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {LockedLP} from "../src/LockedLP.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {AntiSnipe} from "../src/AntiSnipe.sol";
import {Migration} from "../src/Migration.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DiscipleHook} from "../src/DiscipleHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @title Deploy DISCIPLE to Robinhood Chain (or local anvil) with real v4 PoolManager
contract Deploy is Script {
    function run() external {
        address treasury = vm.envOr("TREASURY", address(0));

        vm.startBroadcast();
        address deployer = msg.sender;
        if (treasury == address(0)) treasury = deployer;

        ReferralRegistry referrals = new ReferralRegistry(deployer);
        LockedLP lockedLP = new LockedLP(deployer, treasury);
        FeeRouter feeRouter = new FeeRouter(deployer, treasury, address(referrals));

        PoolManager manager = new PoolManager(deployer);
        uint160 flags = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        bytes memory ctorArgs = abi.encode(IPoolManager(address(manager)), feeRouter, address(0));
        (address hookAddr, bytes32 salt) = HookMiner.find(deployer, flags, type(DiscipleHook).creationCode, ctorArgs);
        DiscipleHook hook = new DiscipleHook{salt: salt}(IPoolManager(address(manager)), feeRouter, address(0));
        require(address(hook) == hookAddr, "hook");

        Migration migration = new Migration(deployer, address(lockedLP), address(manager), address(hook));
        hook.setMigration(address(migration));
        lockedLP.setMigration(address(migration));
        lockedLP.setPoolManager(address(manager));

        uint64 n = uint64(vm.getNonce(deployer));
        address launchpadAddr = vm.computeCreateAddress(deployer, n + 1);
        AntiSnipe antiSnipe = new AntiSnipe(launchpadAddr);
        Launchpad launchpad = new Launchpad(deployer, address(feeRouter), address(antiSnipe), address(migration));
        require(address(launchpad) == launchpadAddr, "Deploy: launchpad address mismatch");

        feeRouter.setLaunchpad(address(launchpad));
        feeRouter.setLockedLP(address(lockedLP));
        feeRouter.setAuthorized(address(hook), true);

        vm.stopBroadcast();

        console2.log("PoolManager", address(manager));
        console2.log("DiscipleHook", address(hook));
        console2.log("ReferralRegistry", address(referrals));
        console2.log("LockedLP", address(lockedLP));
        console2.log("FeeRouter", address(feeRouter));
        console2.log("AntiSnipe", address(antiSnipe));
        console2.log("Migration", address(migration));
        console2.log("Launchpad", address(launchpad));
    }
}

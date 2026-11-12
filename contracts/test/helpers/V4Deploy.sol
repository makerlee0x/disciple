// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {Migration} from "../../src/Migration.sol";
import {AscensionHook} from "../../src/AscensionHook.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";

/// @dev Shared v4 stack deployer for tests (PoolManager + mined AscensionHook + Migration).
library V4Deploy {
    struct Stack {
        IPoolManager manager;
        AscensionHook hook;
        Migration migration;
        DiscipleRouter router;
    }

    function deploy(address owner, LockedLP lockedLP, FeeRouter feeRouter) internal returns (Stack memory s) {
        PoolManager manager = new PoolManager(owner);
        s.manager = IPoolManager(address(manager));

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );

        bytes memory ctorArgs = abi.encode(s.manager, feeRouter, address(0), address(this));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(AscensionHook).creationCode, ctorArgs);

        AscensionHook hook = new AscensionHook{salt: salt}(s.manager, feeRouter, address(0), address(this));
        require(address(hook) == hookAddr, "hook addr");

        Migration migration = new Migration(owner, address(lockedLP), address(s.manager), address(hook));
        hook.setMigration(address(migration));
        // Caller must owner-prank: lockedLP.setMigration + setPoolManager

        s.router = new DiscipleRouter(s.manager, lockedLP, address(hook));
        hook.setTrustedRouter(address(s.router), true);
        hook.setLiquidityManager(address(lockedLP), true);
        hook.setCompounder(address(lockedLP), 250_000);
        s.hook = hook;
        s.migration = migration;
    }
}

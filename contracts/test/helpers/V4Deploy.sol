// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {Migration} from "../../src/Migration.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";

/// @dev Shared v4 stack deployer for tests (PoolManager + mined DiscipleHook + Migration).
library V4Deploy {
    struct Stack {
        IPoolManager manager;
        DiscipleHook hook;
        Migration migration;
        DiscipleRouter router;
    }

    /// @dev Community rewards Safe stand-in used by every test stack.
    address internal constant COMMUNITY = address(0xC0FFEE0001);

    function deploy(address owner, LockedLP lockedLP, FeeRouter feeRouter) internal returns (Stack memory s) {
        PoolManager manager = new PoolManager(owner);
        s.manager = IPoolManager(address(manager));

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );

        // maker 2026-11-19: the hook holds fees and pays fixed recipients; tests use the FeeRouter's treasury and a
        // fixed community-Safe stand-in.
        address treasury = feeRouter.treasury();
        bytes memory ctorArgs = abi.encode(s.manager, address(0), address(this), treasury, COMMUNITY);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(DiscipleHook).creationCode, ctorArgs);

        DiscipleHook hook = new DiscipleHook{salt: salt}(s.manager, address(0), address(this), treasury, COMMUNITY);
        require(address(hook) == hookAddr, "hook addr");

        Migration migration = new Migration(owner, address(lockedLP), address(s.manager), address(hook));
        hook.setMigration(address(migration));
        // Caller must owner-prank lockedLP.setHook(address(hook)) too (LockedLP owner).
        // Caller must owner-prank: lockedLP.setMigration + setPoolManager

        s.router = new DiscipleRouter(s.manager, lockedLP, address(hook));
        s.hook = hook;
        s.migration = migration;
    }
}

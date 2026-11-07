// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {TwapOracle} from "./libraries/TwapOracle.sol";

/// @notice Compatible quote/USDG source-pool hook. Records actual history at every swap, not at permissionless pokes.
/// @dev Deploy at an address with AFTER_INITIALIZE and BEFORE_SWAP flags. Every swap integrates its PRE-swap tick
///      over the interval since the preceding observation. The live pool tick is used only for the tail after the
///      last swap; restoring a price in the same timestamp has zero duration. No tick truncation or sampled history.
///      Owner selects this source via QuotePricer.setPricePool. Existing hookless pools cannot gain hooks in place.
contract QuoteSourceOracle {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    mapping(PoolId => TwapOracle.State) private _history;
    error OnlyPoolManager();
    error WrongSource();

    constructor(IPoolManager manager) {
        poolManager = manager;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.afterInitialize = true;
        p.beforeSwap = true;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick) external returns (bytes4) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        TwapOracle.initialize(_history[key.toId()], tick);
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        external returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        PoolId id = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(id);
        // maxDelta=0: exact, untruncated pre-swap tick weights the elapsed interval.
        TwapOracle.write(_history[id], tick, 0, false);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function consult(PoolKey calldata key, uint32 window) external view returns (int24 tick, uint32 actualWindow) {
        if (address(key.hooks) != address(this)) revert WrongSource();
        PoolId id = key.toId();
        (, int24 currentTick,,) = poolManager.getSlot0(id);
        return TwapOracle.consult(_history[id], window, currentTick);
    }
}

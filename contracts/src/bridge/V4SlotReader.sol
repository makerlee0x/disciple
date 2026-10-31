// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @title Remote v4 slot0 reader for LayerZero lzRead
/// @notice Deploy this next to the reference PoolManager, on the chain that holds the v4 pool.
///         Disciple's lzRead target calls `read`. The local hook records the tick into its own
///         ring and builds the 30-minute TWAP there. This contract stores nothing.
contract V4SlotReader {
    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function read(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity) {
        PoolId id = PoolId.wrap(poolId);
        (sqrtPriceX96, tick,,) = StateLibrary.getSlot0(manager, id);
        liquidity = StateLibrary.getLiquidity(manager, id);
    }
}

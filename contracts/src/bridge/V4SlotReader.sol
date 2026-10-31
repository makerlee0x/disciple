// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @title Standalone v4 slot0 reader
/// @notice `AnchorLens.readV4Slot` is the view Disciple's lzRead calls. This contract is the same
///         sample against one immutable PoolManager, for a caller that already holds that manager.
///         A single sample is not a 30-minute TWAP. The pool-chain ring builds the mean.
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @notice The hook's entry point for a pushed price (every route ends here).
interface IDisciplePriceTarget {
    function onBridgePrice(
        PoolId id,
        uint32 srcEid,
        uint8 kind,
        address target,
        bytes32 v4Id,
        uint256 a,
        uint256 b,
        uint64 observedAt,
        address keeper,
        uint256 keeperCost
    ) external;
}

/// @title DiscipleSourceReader
/// @notice Shared by every home-chain sender: reads a source pool's raw state on this chain. The caller never
///         supplies a price; a sender always reads it here, in the same transaction that sends it.
abstract contract DiscipleSourceReader {
    uint8 internal constant SRC_V2 = 1;
    uint8 internal constant SRC_V3 = 2;
    uint8 internal constant SRC_V4 = 3;

    error BadSource();

    /// @notice Raw source state: v2 (reserve0, reserve1); v3 and v4 (sqrtPriceX96, liquidity).
    /// @param target v2 pair / v3 pool / v4 PoolManager (with `v4Id`)
    function read(uint8 kind, address target, bytes32 v4Id) public view returns (uint256 a, uint256 b) {
        if (kind == SRC_V2) {
            (bool ok, bytes memory r) = target.staticcall(abi.encodeWithSignature("getReserves()"));
            if (!ok || r.length < 64) revert BadSource();
            (a, b) = abi.decode(r, (uint256, uint256));
        } else if (kind == SRC_V3) {
            (bool ok, bytes memory r) = target.staticcall(abi.encodeWithSignature("slot0()"));
            if (!ok || r.length < 32) revert BadSource();
            a = abi.decode(r, (uint160));
            (ok, r) = target.staticcall(abi.encodeWithSignature("liquidity()"));
            if (!ok || r.length < 32) revert BadSource();
            b = abi.decode(r, (uint128));
        } else if (kind == SRC_V4) {
            (uint160 sqrtP,,,) = StateLibrary.getSlot0(IPoolManager(target), PoolId.wrap(v4Id));
            a = sqrtP;
            b = StateLibrary.getLiquidity(IPoolManager(target), PoolId.wrap(v4Id));
        } else {
            revert BadSource();
        }
        if (a == 0) revert BadSource();
    }

    /// @dev The call the hook receives. `srcEid` is 0 on native-bridge routes (the bridge itself proves origin).
    function _payload(
        PoolId id,
        uint8 kind,
        address target,
        bytes32 v4Id,
        uint256 a,
        uint256 b,
        uint256 keeperCost
    ) internal view returns (bytes memory) {
        return abi.encodeCall(
            IDisciplePriceTarget.onBridgePrice,
            (id, 0, kind, target, v4Id, a, b, uint64(block.timestamp), msg.sender, keeperCost)
        );
    }
}

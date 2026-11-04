// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiscipleDepth as DP} from "../libraries/DiscipleDepth.sol";

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

    /// @dev v4 depth-counter reads per source per push; `track` runs a full first pass (its caller pays).
    uint256 internal constant WALK_STEPS = 8;
    uint256 internal constant TRACK_STEPS = 1_000_000;

    /// @notice v4 depth counters (DiscipleDepth) by keccak256(manager, poolId), started by `track`.
    mapping(bytes32 => DP.Walk) internal walks;

    error BadSource();

    /// @notice Start counting a v4 source's real TVL here. Anyone may call it (normally the pool's creator at
    ///         launch); the key must hash to the pool id. Until it is tracked, a v4 source sends the in-range
    ///         estimate, which reads high and delays graduation.
    function track(address manager, PoolKey calldata key) external {
        bytes32 id = keccak256(abi.encode(key));
        DP.Walk storage w = walks[keccak256(abi.encode(manager, id))];
        if (w.spacing != 0) return;
        (uint160 sqrtP,,,) = StateLibrary.getSlot0(IPoolManager(manager), PoolId.wrap(id));
        if (sqrtP == 0 || key.tickSpacing <= 0) revert BadSource();
        w.spacing = key.tickSpacing;
        DP.step(w, IPoolManager(manager), PoolId.wrap(id), TRACK_STEPS);
    }

    /// @dev Advance a tracked v4 source's counter (inside a push).
    function _walk(uint8 kind, address target, bytes32 v4Id) internal {
        if (kind != SRC_V4) return;
        DP.Walk storage w = walks[keccak256(abi.encode(target, v4Id))];
        if (w.spacing != 0) DP.step(w, IPoolManager(target), PoolId.wrap(v4Id), WALK_STEPS);
    }

    /// @notice Source state as sent: v2 (reserve0, reserve1); v3 and v4 (sqrtPriceX96, L) where L is the
    ///         full-range liquidity worth the pool's REAL tokens at this price, so the hook's TVL
    ///         (2 L sqrtP, in either token) is the real TVL: v3 from the pool's token balances, v4 from its depth
    ///         counter once a pass has finished (before that, or untracked, its in-range liquidity).
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
            b = _equivL(a, _bal(target, "token0()"), _bal(target, "token1()"));
        } else if (kind == SRC_V4) {
            (uint160 sqrtP,,,) = StateLibrary.getSlot0(IPoolManager(target), PoolId.wrap(v4Id));
            a = sqrtP;
            DP.Walk storage w = walks[keccak256(abi.encode(target, v4Id))];
            b = w.done ? _equivL(a, w.tot0, w.tot1) : StateLibrary.getLiquidity(IPoolManager(target), PoolId.wrap(v4Id));
        } else {
            revert BadSource();
        }
        if (a == 0) revert BadSource();
    }

    /// @dev `pool`'s balance of the token its `sel()` names.
    function _bal(address pool, string memory sel) internal view returns (uint256) {
        (bool ok, bytes memory r) = pool.staticcall(abi.encodeWithSignature(sel));
        if (!ok || r.length < 32) revert BadSource();
        (ok, r) = abi.decode(r, (address)).staticcall(abi.encodeWithSignature("balanceOf(address)", pool));
        if (!ok || r.length < 32) revert BadSource();
        return abi.decode(r, (uint256));
    }

    /// @dev Full-range liquidity worth (x0, x1) at sqrtP: 2 L sqrtP / 2^96 = x0 P + x1, the same L in either token.
    function _equivL(uint256 sqrtP, uint256 x0, uint256 x1) internal pure returns (uint256 l) {
        l = (Math.mulDiv(x0, sqrtP, 1 << 96) + Math.mulDiv(x1, 1 << 96, sqrtP)) / 2;
        if (l > type(uint128).max) l = type(uint128).max;
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

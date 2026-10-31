// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeV3Anchor} from "./libraries/BridgeV3Anchor.sol";
import {IV4OracleHook} from "./interfaces/IV4OracleHook.sol";

/// @title Reference-chain view that LayerZero Read calls
/// @notice Deploy one lens on the chain that holds the reference pool. Disciple's read command
///         staticcalls this contract. It does not store prices and nobody can push one.
///         The window is the protocol's 30 minutes. A caller cannot ask for a one-block spot.
contract AnchorLens {
    /// @notice 30-minute v3 `observe` of `coin` / `quote`, plus both balances valued at that TWAP.
    ///         Reverts when the pool has less than 30 minutes of oracle history. No `slot0` fallback.
    function readV3(address pool, address coin, address quote, uint8 coinDec, uint8 quoteDec)
        external
        view
        returns (uint256 priceWad, uint256 tvlWad)
    {
        return BridgeV3Anchor.read(pool, coin, quote, coinDec, quoteDec);
    }

    /// @notice 30-minute `consult` on a v4 oracle hook. The hook owns the units.
    function readV4Oracle(address oracleHook, bytes32 poolId) external view returns (uint256 priceWad, uint256 tvlWad) {
        return IV4OracleHook(oracleHook).consult(poolId, uint32(C.TWAP_WINDOW));
    }

    /// @notice One v4 `slot0` sample. A single remote view is not a 30-minute TWAP. The pool-chain
    ///         hook records the tick into its own ring and builds the TWAP there, the same way a
    ///         same-chain self-sample does. This call does not read the spot into a price wad.
    function readV4Slot(address manager, bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity)
    {
        PoolId id = PoolId.wrap(poolId);
        IPoolManager pm = IPoolManager(manager);
        (sqrtPriceX96, tick,,) = StateLibrary.getSlot0(pm, id);
        liquidity = StateLibrary.getLiquidity(pm, id);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Dollar depth from a v4 pool's current in-range liquidity and price.
/// @dev Reserves are the virtual amounts implied by in-range L at the current sqrtPrice (full-range
///      equivalent of that L). USD is WAD ($1e18 = $1). `priceWad` is USD WAD per 1e18 raw units of the token.
library PoolDepth {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant Q96 = 2 ** 96;

    function virtualReserves(IPoolManager pm, PoolKey memory key)
        internal
        view
        returns (uint256 amount0, uint256 amount1)
    {
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        uint128 L = pm.getLiquidity(key.toId());
        if (sqrtP == 0 || L == 0) return (0, 0);
        amount0 = Math.mulDiv(uint256(L), Q96, sqrtP);
        amount1 = Math.mulDiv(uint256(L), sqrtP, Q96);
    }

    function sideUsd(uint256 raw, uint256 priceWad) internal pure returns (uint256) {
        if (raw == 0 || priceWad == 0) return 0;
        return Math.mulDiv(raw, priceWad, 1e18);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @title Permissionless base/USDG pool discovery (Uniswap v4)
/// @notice Candidates are the hookless v4 pools of (base, USDG) at the standard fee / tickSpacing tiers:
///         0.01%/1, 0.05%/10, 0.30%/60, 1.00%/200. The initialized candidate with the most in-range liquidity wins.
library BasePools {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function keyAt(address base, address usdg, uint256 i) internal pure returns (PoolKey memory key) {
        uint24 fee;
        int24 ts;
        if (i == 0) (fee, ts) = (100, 1);
        else if (i == 1) (fee, ts) = (500, 10);
        else if (i == 2) (fee, ts) = (3000, 60);
        else (fee, ts) = (10_000, 200);
        (address c0, address c1) = uint160(base) < uint160(usdg) ? (base, usdg) : (usdg, base);
        key = PoolKey({
            currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: fee, tickSpacing: ts, hooks: IHooks(address(0))
        });
    }

    /// @return found  true if any candidate pool is initialized
    /// @return best   the deepest initialized candidate
    /// @return liq    its current in-range liquidity
    function discover(IPoolManager pm, address base, address usdg)
        internal
        view
        returns (bool found, PoolKey memory best, uint128 liq)
    {
        for (uint256 i; i < 4; ++i) {
            PoolKey memory k = keyAt(base, usdg, i);
            (uint160 sp,,,) = pm.getSlot0(k.toId());
            if (sp == 0) continue;
            uint128 l = pm.getLiquidity(k.toId());
            if (!found || l > liq) (found, best, liq) = (true, k, l);
        }
    }
}

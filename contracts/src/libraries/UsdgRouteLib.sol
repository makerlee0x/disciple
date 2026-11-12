// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Shared validation for an owner-registered USDG → quote v4 route of 1 or 2 hops.
/// @dev A 2-hop mid token may be address(0) (native ETH). CurrencySettler already settles native, so
///      an owner can register that route later without a router redeploy. This build does not ship a
///      dedicated native-ETH path or tests. Fee and hooks on each PoolKey are left as-is (dynamic-fee
///      flag 0x800000 and non-DISCIPLE hooks are valid). Validation does not inspect the fee value.
library UsdgRouteLib {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant MAX_HOPS = 2;

    /// @dev Walk USDG-first `keys` and confirm they form USDG → quote. Returns false on any mismatch,
    ///      uninitialized pool, tickSpacing 0, or a hop that uses `forbiddenHook` (the DISCIPLE hook).
    function check(IPoolManager pm, address usdg, address quote, PoolKey[] memory keys, address forbiddenHook)
        internal
        view
        returns (bool)
    {
        if (quote == address(0) || quote == usdg) return false;
        uint256 n = keys.length;
        if (n == 0 || n > MAX_HOPS) return false;
        address cur = usdg;
        address mid;
        for (uint256 i; i < n; ++i) {
            PoolKey memory k = keys[i];
            if (k.tickSpacing == 0) return false;
            if (forbiddenHook != address(0) && address(k.hooks) == forbiddenHook) return false;
            (uint160 sp,,,) = pm.getSlot0(k.toId());
            if (sp == 0) return false;
            address c0 = Currency.unwrap(k.currency0);
            address c1 = Currency.unwrap(k.currency1);
            if (cur == c0) cur = c1;
            else if (cur == c1) cur = c0;
            else return false;
            if (i == 0 && n == 2) mid = cur;
        }
        if (cur != quote) return false;
        if (n == 2 && (mid == usdg || mid == quote)) return false;
        return true;
    }

    /// @dev Next currency after selling `tokenIn` through `key`. Returns address(1) if `tokenIn` is not in the pool
    ///      (address(0) is a valid native-ETH currency).
    function other(PoolKey memory key, address tokenIn) internal pure returns (address) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (tokenIn == c0) return c1;
        if (tokenIn == c1) return c0;
        return address(1);
    }
}

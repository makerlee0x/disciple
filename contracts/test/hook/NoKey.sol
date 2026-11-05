// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @dev An empty source key, for `CreateParams.srcKey` when the source is not a same-chain v4 pool.
function _noKey() pure returns (PoolKey memory k) {}

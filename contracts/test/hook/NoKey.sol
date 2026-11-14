// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";

/// @dev An empty source key, for `CreateParams.srcKey` when the source is not a same-chain v4 pool.
function _noKey() pure returns (PoolKey memory k) {}

/// @dev v0.2's behaviour as v0.3 creator settings: edge 1bp, lam 0.05, tip gas + 20%, skim 12%.
function _v02Tune() pure returns (DiscipleHook.Tune memory) {
    return DiscipleHook.Tune({edgeBps: 1, lamPpm: 50_000, tipBps: 12_000, skimBps: 1200});
}

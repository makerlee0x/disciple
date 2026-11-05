// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DiscipleLedger as LG} from "./libraries/DiscipleLedger.sol";
import {DiscipleDepth as DP} from "./libraries/DiscipleDepth.sol";

/// @title DiscipleBooks
/// @notice Linked (external) entry points for the LP ledger, so the hook stays under the 24 KB code limit. Each call
///         is a DELEGATECALL into this library operating on the hook's own storage; the logic is DiscipleLedger's,
///         unchanged. Only the O(1) swap record stays inlined in the hook.
library DiscipleBooks {
    using LG for LG.Book;

    function init(LG.Book storage bk, address creator, uint256 x, uint256 y, uint256 markX128) public {
        bk.init(creator, x, y, markX128);
    }

    /// @notice Advance the v4 source depth counter (DiscipleDepth) by up to `steps` reads.
    function walk(DP.Walk storage w, IPoolManager pm, PoolId id, uint256 steps) public {
        DP.step(w, pm, id, steps);
    }

    function settle(LG.Book storage bk, uint256 markX128, uint256 creatorTvl, uint256 gradTvl, bool distribute)
        public
    {
        bk.settle(markX128, creatorTvl, gradTvl, distribute);
    }

    function deposit(LG.Book storage bk, address owner, uint256 dx, uint256 dy)
        public
        returns (uint256 id, uint256 shares, uint256 takeX, uint256 takeY)
    {
        return bk.deposit(owner, dx, dy);
    }

    function withdraw(LG.Book storage bk, uint256 id, address owner, uint256 s, uint256 bal)
        public
        returns (uint256 cx, uint256 cy)
    {
        return bk.withdraw(id, owner, s, bal);
    }

    function restake(LG.Book storage bk, uint256 id, address owner) public returns (uint256) {
        return bk.restake(id, owner);
    }

    function claim(LG.Book storage bk, uint256 id, address owner) public returns (uint256, uint256) {
        return bk.claim(id, owner);
    }

    function claimCreator(LG.Book storage bk) public returns (uint256, uint256) {
        return bk.claimCreator();
    }

    function poke(LG.Book storage bk, uint256 id) public returns (uint256, uint256, uint256, uint256) {
        return bk.poke(id);
    }
}

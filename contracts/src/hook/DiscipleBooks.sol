// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiscipleLedger as LG} from "./libraries/DiscipleLedger.sol";
import {DiscipleDepth as DP} from "./libraries/DiscipleDepth.sol";
import {DiscipleSwapMath as SM} from "./libraries/DiscipleSwapMath.sol";

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

    function settle(LG.Book storage bk, uint256 markX128, uint256 onTvl, uint256 offTvl, uint256 gradTvl, bool dist)
        public
    {
        bk.settle(markX128, onTvl, offTvl, gradTvl, dist);
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

    /// @dev Same-chain lag premium, in seconds of `block.timestamp` measured from `premAt`. Elapsed 0 is the full
    ///      4%. Elapsed >= 1 is off. Timestamps are whole seconds, so the linear fade has no step between those.
    uint256 internal constant PREMIUM_TAU = 1;

    /// @notice Same-chain slopes and match bounds. The 4% lag premium fades over `PREMIUM_TAU` seconds from
    ///         `premAt` (the sample time) and is applied on one side: buys when `premBuy`, otherwise sells.
    ///         The other side pays the fee only.
    function sameQuote(
        uint256 anchorX128,
        uint256 tX128,
        uint24 fee,
        uint64 premAt,
        bool premBuy,
        uint256 spot,
        uint24 srcFee,
        uint256 nowTs
    ) public pure returns (uint256 kb, uint256 ks, uint256 pb, uint256 ps) {
        uint256 h = SM.premium(4e16, PREMIUM_TAU, nowTs - premAt);
        uint256 gOn = SM.markup(h, fee);
        uint256 gOff = h == 1e18 ? gOn : SM.markup(1e18, fee);
        (kb, ks) = SM.slopes(anchorX128, tX128, premBuy ? gOn : gOff, premBuy ? gOff : gOn);
        uint256 srcAsk = Math.mulDiv(spot, 1e6, 1e6 - srcFee, Math.Rounding.Ceil);
        uint256 srcBid = Math.mulDiv(spot, 1e6 - srcFee, 1e6);
        (pb, ps) = SM.matchBounds(srcAsk, srcBid, 1);
    }
}

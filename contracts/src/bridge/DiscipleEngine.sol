// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeArb} from "./libraries/BridgeArb.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";

/// @title Disciple curve and arb math
/// @notice Stateless quotes for Disciple (`DiscipleHook`). The hook keeps custody and calls here so
///         Disciple deploys under the 24kb limit. This contract holds no tokens, has no admin, and its
///         address is fixed on the hook at construction. Calling it directly only runs the quote.
contract DiscipleEngine {
    function buy(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 usdgGross)
        external
        pure
        returns (BridgeCurve.S memory, BridgeCurve.Fill memory)
    {
        return BridgeCurve.buyExactIn(s, usdgGross, ctx);
    }

    function sell(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 coinIn)
        external
        pure
        returns (BridgeCurve.S memory, BridgeCurve.Fill memory)
    {
        return BridgeCurve.sellExactIn(s, coinIn, ctx);
    }

    /// @dev Normalized amounts. `buyCoin` is set even when `amountIn` is zero.
    function quote(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx)
        external
        pure
        returns (bool buyCoin, uint256 amountIn, uint256 amountOut, uint256 profitWad)
    {
        BridgeArb.Quote memory q = BridgeArb.quote(s, ctx);
        return (q.buyCoin, q.amountIn, q.amountOut, q.profitWad);
    }

    /// @dev Profit of one exact-in size. Zero when the fill is capped or unprofitable.
    function fill(BridgeCurve.S memory s, BridgeCurve.Ctx memory ctx, uint256 amount, bool buyCoin)
        external
        pure
        returns (uint256 amountOut, uint256 profitWad)
    {
        if (amount == 0) return (0, 0);
        if (buyCoin) {
            (, BridgeCurve.Fill memory f) = BridgeCurve.buyExactIn(s, amount, ctx);
            if (f.capped || f.usdgIn != amount || f.coinOut == 0) return (0, 0);
            uint256 mark = Math.mulDiv(f.coinOut, s.anchor, 1e18);
            if (mark <= f.usdgIn) return (0, 0);
            return (f.coinOut, mark - f.usdgIn);
        }
        (, BridgeCurve.Fill memory sold) = BridgeCurve.sellExactIn(s, amount, ctx);
        if (sold.capped || sold.coinIn != amount || sold.usdgOut == 0) return (0, 0);
        uint256 cost = Math.mulDiv(sold.coinIn, s.anchor, 1e18);
        if (sold.usdgOut <= cost) return (0, 0);
        return (sold.usdgOut, sold.usdgOut - cost);
    }

    /// @dev External so the hook and the LP facet do not inline the decay series into their bytecode.
    function decayed(uint256 volume, uint256 dt, uint256 halfLife) external pure returns (uint256) {
        return BridgeFee.decayed(volume, dt, halfLife);
    }

    /// @dev Rev fee before the staleness multiplier. Same helper the curve uses.
    function feeBps(uint256 tvl, uint256 gradTvl, uint256 volume, uint256 redLineWad, uint256 tvlRef)
        external
        pure
        returns (uint256)
    {
        return BridgeFee.revBps(tvl, gradTvl, volume, redLineWad, tvlRef);
    }
}

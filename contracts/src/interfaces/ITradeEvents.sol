// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Curve trade event (emitted by every BondingCurve pre-grad). DiscipleHook emits the post-grad variant in
///        IHookTradeEvents (same name and fields, last field = sqrtPriceAfter instead of mcapAfterUsd).
interface ITradeEvents {
    /// @param token        Launch token
    /// @param trader       Recipient of the output (buy: token receiver; sell: token seller / quote receiver)
    /// @param isBuy        true = quote → token
    /// @param quoteAmt     Quote moved by the trader (buy: gross quote paid; sell: net quote received)
    /// @param tokenAmt     Tokens moved by the trader (buy: net tokens received; sell: tokens sold)
    /// @param fee          Protocol 1% + creator tax, in quote raw units (post-grad: hook fee; if it was
    ///                     charged in the launch token it is converted to quote at priceAfterX18)
    /// @param snipeFee     Anti-snipe fee in quote raw units (always 0 post-grad)
    /// @param priceBeforeX18 Spot price before, quote raw * 1e18 / token raw
    /// @param priceAfterX18  Spot price after, same units
    /// @param impactBps    UNSIGNED absolute |priceAfter - priceBefore| / priceBefore in bps (full precision).
    ///                     Direction is given by isBuy (buy → price up, sell → price down); negate for sells
    ///                     client-side if a signed value is wanted.
    /// @param mcapAfterUsd Market cap after trade, USD WAD (uses launch-time quote/USD price)
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 quoteAmt,
        uint256 tokenAmt,
        uint256 fee,
        uint256 snipeFee,
        uint256 priceBeforeX18,
        uint256 priceAfterX18,
        uint256 impactBps,
        uint256 mcapAfterUsd
    );
}

/// @title Post-graduation trade event (emitted by DiscipleHook on every v4 swap)
/// @notice Same fields as ITradeEvents.Trade except the last one: the hook emits the raw v4 `sqrtPriceAfter` instead of
///         a USD mcap (gas G-1: no on-chain QuotePricer TWAP call per swap). Different signature => different topic0:
///         Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint160).
///         Off-chain USD mcap = DiscipleHook.mcapUsdFromSqrt(sqrtPriceAfter, tokenIsC0, quoteUsd), with quoteUsd from
///         DiscipleHook.quoteUsdOf(poolId) (live) or the coin's launch-time QuotePriced value.
interface IHookTradeEvents {
    /// @param sqrtPriceAfter v4 pool sqrtPriceX96 after the swap (slot0). Other params: see ITradeEvents.Trade.
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 quoteAmt,
        uint256 tokenAmt,
        uint256 fee,
        uint256 snipeFee,
        uint256 priceBeforeX18,
        uint256 priceAfterX18,
        uint256 impactBps,
        uint160 sqrtPriceAfter
    );
}

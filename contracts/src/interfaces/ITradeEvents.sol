// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Unified trade event (emitted by every BondingCurve pre-grad and by DiscipleHook post-grad)
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
    /// @param impactBps    |priceAfter - priceBefore| / priceBefore in bps, computed at full precision
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

/**
 * USD values of one Trade event: the ONLY place the indexer turns a Trade into USD (price, volume, mcap).
 * Swap point for the #75 redeploy (FLOW): the hook's Trade event drops mcapAfterUsd in favour of sqrtPriceAfter, so
 * mcap will be computed here (price from sqrtPriceAfter via math.priceWadFromSqrt × quote USD × total supply, see
 * math.mcapUsdWad) instead of read from the event. Everything downstream (trades rows, coin_stats aggregates, candles,
 * listCoins last_mcap, holdings lastPriceUsd) reads what this returns.
 */
export type TradeUsdInput = {
  /** coins.quote_price_usd (wad string, launch-time QuotePriced) */
  quotePriceUsdWad: string | null;
  quoteAmt: bigint;
  priceAfterX18: bigint;
  /** current Trade event field; absent after #75 */
  mcapAfterUsd?: bigint;
};
export type TradeUsd = { priceUsd: number; volumeUsd: number; /** wad string, stored in trades.mcap_usd */ mcapUsdWad: string };

export function tradeUsd(t: TradeUsdInput): TradeUsd {
  const qUsd = Number(BigInt(t.quotePriceUsdWad ?? "0")) / 1e18;
  return {
    priceUsd: (Number(t.priceAfterX18) / 1e18) * qUsd,
    volumeUsd: (Number(t.quoteAmt) / 1e18) * qUsd,
    mcapUsdWad: (t.mcapAfterUsd ?? 0n).toString(),
  };
}

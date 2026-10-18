import { mcapUsdFromSqrt, priceWadFromSqrt, TOTAL_SUPPLY } from "./math.js";

/**
 * USD values of one Trade event: the ONLY place the indexer turns a Trade into USD (price, volume, mcap).
 *  - curve Trade (all stacks) and pre-v4 hook Trade: mcap = the event's mcapAfterUsd (launch-time quote price).
 *  - v4 hook Trade (IHookTradeEvents): no mcapAfterUsd; the event carries the pool's sqrtPriceAfter, so
 *    mcap = math.mcapUsdFromSqrt(sqrtPriceAfter, tokenIsC0 = token < quote, launch quote USD, total supply) and
 *    price = math.priceWadFromSqrt(...) — the same formula as DiscipleHook.mcapUsdFromSqrt, full precision (no floored
 *    priceWad for 6-dec quotes). Everything downstream (trades rows, coin_stats, candles, listCoins last_mcap, holdings
 *    lastPriceUsd) reads what this returns.
 */
export type TradeUsdInput = {
  /** coins.quote_price_usd (wad string, launch-time QuotePriced) */
  quotePriceUsdWad: string | null;
  quoteAmt: bigint;
  priceAfterX18: bigint;
  /** curve / legacy hook Trade field */
  mcapAfterUsd?: bigint;
  /** v4 hook Trade field (sqrtPriceX96 after the swap) */
  sqrtPriceAfter?: bigint;
  /** needed with sqrtPriceAfter: pool currency order + supply */
  token?: string;
  quote?: string;
  totalSupply?: bigint | string | null;
};
export type TradeUsd = { priceUsd: number; volumeUsd: number; /** wad string, stored in trades.mcap_usd */ mcapUsdWad: string };

export function tradeUsd(t: TradeUsdInput): TradeUsd {
  const qWad = BigInt(t.quotePriceUsdWad ?? "0");
  const qUsd = Number(qWad) / 1e18;
  const volumeUsd = (Number(t.quoteAmt) / 1e18) * qUsd;
  if (t.mcapAfterUsd === undefined && t.sqrtPriceAfter !== undefined && t.token && t.quote) {
    const tokenIsC0 = BigInt(t.token) < BigInt(t.quote);
    const supply = t.totalSupply ? BigInt(t.totalSupply) : TOTAL_SUPPLY;
    const p = t.sqrtPriceAfter > 0n ? priceWadFromSqrt(t.sqrtPriceAfter, tokenIsC0) : t.priceAfterX18;
    return { priceUsd: (Number(p) / 1e18) * qUsd, volumeUsd, mcapUsdWad: mcapUsdFromSqrt(t.sqrtPriceAfter, tokenIsC0, qWad, supply).toString() };
  }
  return { priceUsd: (Number(t.priceAfterX18) / 1e18) * qUsd, volumeUsd, mcapUsdWad: (t.mcapAfterUsd ?? 0n).toString() };
}

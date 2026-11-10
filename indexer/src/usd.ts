import { mcapUsdFromSqrt, TOTAL_SUPPLY } from "./math.js";

/**
 * USD values of one Trade event: the ONLY place the indexer turns a Trade into USD (price, volume, mcap).
 *  - curve Trade (all stacks) and pre-v4 hook Trade: mcap = the event's mcapAfterUsd (launch-time quote price).
 *  - v4 hook Trade (IHookTradeEvents): no mcapAfterUsd; the event carries the pool's sqrtPriceAfter, so
 *    mcap = math.mcapUsdFromSqrt(sqrtPriceAfter, tokenIsC0 = token < quote, launch quote USD, total supply) — the same
 *    formula as AscensionHook.mcapUsdFromSqrt, full precision.
 *  - price ($/token) = mcap / supply in every case — never the floored priceAfterX18 / priceWad (single digits for
 *    6-dec quotes like USDG; FLOW #115), which is only a last resort when the event carries neither mcap source. Everything downstream (trades rows, coin_stats, candles, listCoins last_mcap, holdings
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
  const supply = t.totalSupply ? BigInt(t.totalSupply) : TOTAL_SUPPLY;
  const supplyTokens = Number(supply) / 1e18;
  // $ per token = mcap / supply (full precision). priceAfterX18 is floored on-chain — a single-digit integer for a
  // 6-dec quote (USDG; FLOW #115) — so it's only the last-resort fallback when neither mcap source is present.
  if (t.mcapAfterUsd === undefined && t.sqrtPriceAfter !== undefined && t.sqrtPriceAfter > 0n && t.token && t.quote) {
    const tokenIsC0 = BigInt(t.token) < BigInt(t.quote);
    const m = mcapUsdFromSqrt(t.sqrtPriceAfter, tokenIsC0, qWad, supply);
    return { priceUsd: Number(m) / 1e18 / supplyTokens, volumeUsd, mcapUsdWad: m.toString() };
  }
  if (t.mcapAfterUsd !== undefined && t.mcapAfterUsd > 0n)
    return { priceUsd: Number(t.mcapAfterUsd) / 1e18 / supplyTokens, volumeUsd, mcapUsdWad: t.mcapAfterUsd.toString() };
  return { priceUsd: (Number(t.priceAfterX18) / 1e18) * qUsd, volumeUsd, mcapUsdWad: (t.mcapAfterUsd ?? 0n).toString() };
}

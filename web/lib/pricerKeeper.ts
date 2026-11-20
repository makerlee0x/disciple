/**
 * QuotePricer keeper (v4). QuotePricer.poke(base) is permissionless and LAGGED: each poke records the current spot
 * for the future TWAP (clamped ±maxTickDelta), and an auto-discovered base only prices after `autoWarmup` (1h) of
 * history. Launches poke their own base in-tx; between launches nobody does ⇒ the TWAP goes stale. This keeper
 * checks every active base once a minute (Vercel cron → app/api/cron/poke-pricer) but only SENDS a poke when one is
 * needed (shouldPoke, maker 2026-11-20: no gas while nothing happens): the price moved, the TWAP can't price, or the
 * last poke is 10 min old (QuotePricer needs observations ≤ twapWindow / 2 = 15 min apart or launches go stale).
 * Active bases = Launchpad.defaultQuote (STRATEGY) + every `quote` seen in Launched events since the stack's start
 * block (new bases are picked up — and poked — on the first run after their launch). USDG is skipped (poke(usdg) is a
 * no-op by contract). Pure + injectable for scripts/test-pricer-keeper.mts.
 */
import type { Address } from "viem";

export const isZero = (a: string) => /^0x0{40}$/i.test(a);

export function activeBases(o: { defaultQuote: string; usdg: string; launchedQuotes: string[]; extra?: string[] }): Address[] {
  const out = new Set<string>();
  for (const q of [o.defaultQuote, ...(o.extra ?? []), ...o.launchedQuotes]) {
    if (!q || !/^0x[0-9a-fA-F]{40}$/.test(q) || isZero(q)) continue;
    if (q.toLowerCase() === o.usdg.toLowerCase()) continue;
    out.add(q.toLowerCase());
  }
  return Array.from(out) as Address[];
}

/** Gas/day for N bases at one poke per base per minute. */
export function dailyCost(o: { bases: number; gasPerPoke: bigint; gasPriceWei: bigint; perDay?: number }) {
  const n = BigInt((o.perDay ?? 1440) * o.bases);
  const gas = n * o.gasPerPoke;
  return { pokes: Number(n), gas, wei: gas * o.gasPriceWei };
}

/** Longest wait between pokes (s). QuotePricer._checkFresh refuses a launch when two observations inside the 30 min window
 *  are more than 15 min apart, so 10 min leaves room for a late or skipped cron run. */
export const POKE_MAX_GAP_SEC = 600;
/** Spot vs TWAP gap that counts as "the price is moving" (bp): poke every minute while it holds, so the TWAP keeps up. */
export const POKE_MOVE_BPS = 100;

/**
 * Poke this base now? Reads are free; only a "yes" costs gas.
 *   twap / spot: QuotePricer.quotePriceUsd / spotPriceUsd (null = the read reverted, e.g. StalePrice / TwapWarmingUp)
 *   lastPokeSec: when this keeper last sent a poke for the base (KV), null = never / unknown
 */
export function shouldPoke(o: { nowSec: number; lastPokeSec: number | null; twap: bigint | null; spot: bigint | null; fresh?: boolean;
  maxGapSec?: number; moveBps?: number }): { poke: boolean; why: "never" | "stale" | "gap" | "moving" | "quiet" } {
  if (o.lastPokeSec == null) return { poke: true, why: "never" };
  if (o.twap == null || o.twap <= BigInt(0) || o.fresh === false) return { poke: true, why: "stale" };
  if (o.nowSec - o.lastPokeSec >= (o.maxGapSec ?? POKE_MAX_GAP_SEC)) return { poke: true, why: "gap" };
  if (o.spot != null && o.spot > BigInt(0)) {
    const d = o.spot > o.twap ? o.spot - o.twap : o.twap - o.spot;
    if (d * BigInt(10_000) >= o.twap * BigInt(o.moveBps ?? POKE_MOVE_BPS)) return { poke: true, why: "moving" };
  }
  return { poke: false, why: "quiet" };
}

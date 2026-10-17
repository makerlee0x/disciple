/**
 * QuotePricer keeper (v4). QuotePricer.poke(base) is permissionless and LAGGED: each poke records the current spot
 * for the future TWAP (clamped ±maxTickDelta), and an auto-discovered base only prices after `autoWarmup` (1h) of
 * history. Launches poke their own base in-tx; between launches nobody does ⇒ the TWAP goes stale. This keeper
 * pokes every active base once a minute (Vercel cron → app/api/cron/poke-pricer).
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

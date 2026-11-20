/**
 * Pair coin board (maker 2026-11-20): the 12 pair coins rockets launch against, ranked by what their rockets did this
 * season. Top PAIR_SAFE are safe; the rest sit under the elimination line and can be swapped for a new pair.
 * Pure: the server feeds it launches, fills and creator-fee burns (lib/server/pairBoard).
 */
import type { Fill } from "@/lib/trades";

export type PairSort = "score" | "volume" | "burned" | "rockets" | "traders";
export const PAIR_SORTS: readonly PairSort[] = ["score", "volume", "burned", "rockets", "traders"];
/** The ranking that decides the elimination line (maker 2026-11-20: a combined score). */
export const PAIR_CUT_BY: PairSort = "score";
/**
 * Combined score weights (sum 100). Each number is scaled to the best pair's (best = full weight), so the score runs
 * 0..1000. Volume and burns cost real money, so they weigh most; rocket and wallet counts are cheap to pad.
 */
export const PAIR_SCORE_WEIGHTS = { volume: 40, burned: 30, rockets: 15, traders: 15 } as const;
/** Ranks 1..PAIR_SAFE are safe; everything below the line is up for elimination. */
export const PAIR_SAFE = 10;

export type PairCoin = { symbol: string; name: string; address: string; decimals: number; icon: string };
export type PairRow = {
  symbol: string;
  name: string;
  address: string;
  icon: string;
  /** rockets launched against this pair in the window */
  rockets: number;
  /** $ traded on those rockets (real USDG in/out when known, else the quote value) */
  volumeUsd: number;
  /** unique wallets that traded those rockets */
  traders: number;
  /** pair coin tokens burned by creator-fee burn mode (whole tokens) */
  burned: number;
  /** those burned tokens at the pair coin's price now (maker 2026-11-20: moves with the coin's market cap) */
  burnedUsd: number;
  /** combined score, 0..1000 (PAIR_SCORE_WEIGHTS) */
  score: number;
};

export type PairLaunch = { token: string; quote: string; block: number };
export type PairBurn = { token: string; quoteRaw: string; block: number };

/** $ of one fill: real USDG when the router saw it, else the quote value. */
export const fillVolume = (f: Pick<Fill, "side" | "usd" | "usdIn" | "usdOut">) =>
  (f.side === "buy" ? f.usdIn : f.usdOut) ?? f.usd ?? 0;

/**
 * One row per pair coin (all of them, zeros included). `fromBlock` / `fromTs` bound the window (0 = all time).
 * Fills whose coin isn't a launch on one of these pairs are ignored.
 */
export function pairBoard(
  pairs: readonly PairCoin[],
  launches: readonly PairLaunch[],
  fills: readonly Fill[],
  burns: readonly PairBurn[],
  /** $ per whole pair coin, now (QuotePricer); a missing price values its burns at $0 */
  prices: Readonly<Record<string, number>>,
  fromBlock = 0,
  fromTs = 0,
): PairRow[] {
  const byAddr = new Map(pairs.map((p) => [p.address.toLowerCase(), p]));
  const quoteOf = new Map<string, string>();
  const acc = new Map(pairs.map((p) => [p.address.toLowerCase(), { rockets: 0, vol: 0, traders: new Set<string>(), burnedRaw: BigInt(0) }]));
  for (const l of launches) {
    const q = l.quote.toLowerCase();
    if (!byAddr.has(q)) continue;
    quoteOf.set(l.token.toLowerCase(), q);
    if (l.block >= fromBlock) acc.get(q)!.rockets++;
  }
  for (const f of fills) {
    if (f.ts < fromTs) continue;
    const q = quoteOf.get(f.coin.toLowerCase());
    if (!q) continue;
    const a = acc.get(q)!;
    a.vol += fillVolume(f);
    if (f.trader) a.traders.add(f.trader.toLowerCase());
  }
  for (const b of burns) {
    if (b.block < fromBlock) continue;
    const q = quoteOf.get(b.token.toLowerCase());
    if (!q) continue;
    try { acc.get(q)!.burnedRaw += BigInt(b.quoteRaw); } catch { /* bad amount */ }
  }
  const rows = pairs.map((p) => {
    const a = acc.get(p.address.toLowerCase())!;
    const burned = Number(a.burnedRaw) / 10 ** p.decimals;
    const px = prices[p.address.toLowerCase()] ?? 0;
    return { symbol: p.symbol, name: p.name, address: p.address.toLowerCase(), icon: p.icon, rockets: a.rockets, volumeUsd: a.vol, traders: a.traders.size, burned, burnedUsd: burned * px, score: 0 };
  });
  return withScores(rows);
}

/** Fills in `score`: Σ weight × (value ÷ the best pair's value), × 10. */
export function withScores<T extends Omit<PairRow, "score"> & { score?: number }>(rows: T[]): (T & { score: number })[] {
  const parts = (["volume", "burned", "rockets", "traders"] as const).map((k) => ({ w: PAIR_SCORE_WEIGHTS[k], v: KEY[k], max: Math.max(0, ...rows.map((r) => KEY[k](r as PairRow))) }));
  return rows.map((r) => ({ ...r, score: Math.round(10 * parts.reduce((s, p) => s + (p.max > 0 ? p.w * (p.v(r as PairRow) / p.max) : 0), 0)) }));
}

const KEY: Record<PairSort, (r: PairRow) => number> = {
  score: (r) => r.score,
  volume: (r) => r.volumeUsd,
  // $ at today's price: token counts can't be compared across coins with different supplies
  burned: (r) => r.burnedUsd,
  rockets: (r) => r.rockets,
  traders: (r) => r.traders,
};
/** Sorted for one ranking; ties fall back to volume, then rockets, then traders, then the list order. */
export function rankPairs(rows: readonly PairRow[], sort: PairSort): (PairRow & { rank: number })[] {
  const order = new Map(rows.map((r, i) => [r.address, i]));
  return rows.slice()
    .sort((a, b) => KEY[sort](b) - KEY[sort](a) || (sort === "burned" ? b.burned - a.burned : 0) || b.volumeUsd - a.volumeUsd || b.rockets - a.rockets || b.traders - a.traders || order.get(a.address)! - order.get(b.address)!)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

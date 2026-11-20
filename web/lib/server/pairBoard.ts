import "server-only";
/**
 * GET /api/leaderboard?sort=pairs&by=score|volume|burned|rockets|traders: the pair coin board (lib/home/pairBoard).
 * Sources:
 *  - launches + fills: the last home build (lib/server/home: same filtered launch list and indexed fills as the lobby)
 *  - burns: CreatorFeeHarvest CreatorFeesRouted logs with destination 2 (burn), kept in KV with a block cursor
 *  - price: each pair coin's $ price now (QuotePricer), so burns are valued at today's market cap
 * Window: this ranked season (lib/duel/season); before Season 1 starts, all time.
 */
import { getAbiItem, type Address } from "viem";
import { quotePricerAbi } from "@/lib/abi";
import { deployment, ZERO } from "@/lib/chains";
import { creatorFeeHarvestAbi, CREATOR_FEE_DESTINATION } from "@/lib/creatorFeeHarvest";
import { seasonAt } from "@/lib/duel/season";
import { pairBoard, rankPairs, PAIR_CUT_BY, PAIR_SAFE, type PairBurn, type PairCoin, type PairRow, type PairSort } from "@/lib/home/pairBoard";
import { WHITELIST_QUOTES } from "@/lib/whitelistQuotes";
import { serverPc } from "./chat/identity";
import { getPairInputs } from "./home";
import { kv } from "./kv";

const CACHE_MS = 30_000;
const PRICE_MS = 60_000;
const CHUNK = BigInt(Math.max(100, Number(process.env.TRADES_CHUNK_BLOCKS) || 5000));
const ROUTED = getAbiItem({ abi: creatorFeeHarvestAbi, name: "CreatorFeesRouted" });

export type PairBoardResponse = {
  sort: "pairs";
  by: PairSort;
  cutBy: PairSort;
  safe: number;
  season: { n: number; startsAt: number; endsAt: number };
  rows: (PairRow & { rank: number })[];
};

type G = { __dscPairBoard?: { at: number; rows: PairRow[]; season: string }; __dscPairPrice?: { at: number; v: Record<string, number> }; __dscSeasonBlock?: Map<number, number> };
const g = globalThis as unknown as G;

export const PAIR_COINS: PairCoin[] = WHITELIST_QUOTES.map((q) => ({ symbol: q.symbol, name: q.name, address: q.address.toLowerCase(), decimals: q.decimals, icon: q.imagePath }));

const burnsKey = (h: string) => `pairs:burns:${h.toLowerCase()}`;
const burnsCur = (h: string) => `pairs:burns:cur:${h.toLowerCase()}`;

/** Catch up on burn-mode fee routes, then every one seen so far. Never throws (a slow RPC leaves the stored list). */
export async function indexBurns(budgetMs = 4_000): Promise<PairBurn[]> {
  const d = deployment(), s = kv();
  const h = d.creatorFeeHarvest;
  if (!h || h === ZERO) return [];
  const read = async () => { try { return JSON.parse((await s.get(burnsKey(h))) ?? "[]") as PairBurn[]; } catch { return []; } };
  if (!(await s.setNX("pairs:burns:lock", "1", 20).catch(() => false))) return read();
  const t0 = Date.now();
  try {
    const pc = serverPc();
    const latest = await pc.getBlockNumber();
    const raw = await s.get(burnsCur(h));
    let cur = raw ? BigInt(raw) : d.fromBlock - BigInt(1);
    let chunk = CHUNK;
    const list = await read();
    let added = false;
    while (cur < latest && Date.now() - t0 < budgetMs) {
      const from = cur + BigInt(1);
      const to = from + chunk - BigInt(1) > latest ? latest : from + chunk - BigInt(1);
      let logs: { args: { token?: string; destination?: number; quoteAmount?: bigint }; blockNumber: bigint | null }[];
      try {
        logs = (await pc.getLogs({ address: h, event: ROUTED, fromBlock: from, toBlock: to })) as never;
      } catch (e) {
        if (chunk > BigInt(50)) { chunk = chunk / BigInt(4); continue; }
        throw e;
      }
      for (const l of logs) {
        if (Number(l.args.destination) !== CREATOR_FEE_DESTINATION.burnQuote || !l.args.token || !l.args.quoteAmount) continue;
        list.push({ token: l.args.token.toLowerCase(), quoteRaw: l.args.quoteAmount.toString(), block: Number(l.blockNumber ?? 0) });
        added = true;
      }
      if (added) await s.set(burnsKey(h), JSON.stringify(list));
      cur = to;
      await s.set(burnsCur(h), cur.toString());
    }
    return list;
  } catch (e) {
    console.warn("[pairs] burn index", (e as Error).message);
    return read();
  } finally {
    await s.del("pairs:burns:lock").catch(() => {});
  }
}

/** $ per whole pair coin right now (QuotePricer.quotePriceUsd: USD WAD per 1e18 raw units), cached PRICE_MS. */
async function prices(): Promise<Record<string, number>> {
  const c = g.__dscPairPrice;
  if (c && Date.now() - c.at < PRICE_MS) return c.v;
  const d = deployment(), pc = serverPc();
  const v: Record<string, number> = {};
  if (d.quotePricer && d.quotePricer !== ZERO) await Promise.all(PAIR_COINS.map(async (p) => {
    // live spot (maker 2026-11-20: no keeper keeps the TWAP warm once launches price from spot); TWAP as a fallback
    const w = await pc.readContract({ address: d.quotePricer, abi: quotePricerAbi, functionName: "spotPriceUsd", args: [p.address as Address] })
      .catch(() => pc.readContract({ address: d.quotePricer, abi: quotePricerAbi, functionName: "quotePriceUsd", args: [p.address as Address] })).catch(() => null);
    if (w != null) v[p.address] = (Number(w) / 1e18) * (10 ** p.decimals / 1e18);
  }));
  if (Object.keys(v).length) g.__dscPairPrice = { at: Date.now(), v };
  return v;
}

/** First block at or after `ts` (ms), by binary search over block timestamps; cached per season start. 0 for ts ≤ 0. */
async function blockAt(ts: number): Promise<number> {
  if (ts <= 0) return 0;
  const cache = (g.__dscSeasonBlock ??= new Map());
  const hit = cache.get(ts);
  if (hit != null) return hit;
  const pc = serverPc();
  let lo = Number(deployment().fromBlock), hi = Number(await pc.getBlockNumber());
  const tsOf = async (n: number) => Number((await pc.getBlock({ blockNumber: BigInt(n) })).timestamp) * 1000;
  if ((await tsOf(hi)) < ts) return hi + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await tsOf(mid)) < ts) lo = mid + 1; else hi = mid;
  }
  cache.set(ts, lo);
  return lo;
}

export async function getPairBoard(by: PairSort): Promise<PairBoardResponse> {
  const now = Date.now();
  const season = seasonAt(now);
  const pre = now < season.startsAt;
  const c = g.__dscPairBoard;
  let rows: PairRow[];
  if (c && now - c.at < CACHE_MS && c.season === season.id) rows = c.rows;
  else {
    const fromTs = pre ? 0 : season.startsAt;
    const [inputs, burns, px, fromBlock] = await Promise.all([
      getPairInputs(),
      indexBurns().catch(() => [] as PairBurn[]),
      prices().catch(() => ({})),
      blockAt(fromTs).catch(() => 0),
    ]);
    rows = pairBoard(PAIR_COINS, inputs.launches, inputs.fills, burns, px, fromBlock, fromTs);
    g.__dscPairBoard = { at: now, rows, season: season.id };
  }
  return { sort: "pairs", by, cutBy: PAIR_CUT_BY, safe: PAIR_SAFE, season: { n: season.n, startsAt: season.startsAt, endsAt: season.endsAt }, rows: rankPairs(rows, by) };
}

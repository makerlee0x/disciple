import "server-only";
/**
 * App home data (trending hero + feed stats), server side. Sources, nothing else:
 *  - coins: lib/events listLaunches (Launched events + live curve / MarketLens mcap, graduated, moderated image)
 *  - trades: the KV trade index (lib/server/trades: indexTrades catch-up + tradesOf), the same fills /api/trades serves
 *  - age: the launch block's timestamp (RPC), hero + strip only
 * Known test coins (lib/home/hiddenCoins) are left out before anything is ranked.
 * Cached in-process for CACHE_MS; every step is time-boxed so a slow RPC degrades to the newest coin / empty state.
 */
import type { PublicClient } from "viem";
import { isDeployed } from "@/lib/chains";
import { listLaunches } from "@/lib/events";
import { publicClient } from "@/lib/protocol-viem";
import { storeSrc, STORE_ID_RE, uriKey } from "@/lib/coinImages";
import { pairOf, pairSymOf, shortHex } from "@/lib/home/pairs";
import { isHiddenCoin } from "@/lib/home/hiddenCoins";
import { chipOf, pickHero, statsFromFills, type HomeCoin, type HomeData } from "@/lib/home/trending";
import { resolveKeys } from "./imageStore";
import { indexTrades, tradesOf } from "./trades";

const CACHE_MS = 15_000;
const FILLS_CAP = 2000;
const MAX_COINS = 120;
const g = globalThis as unknown as { __dscHome?: { at: number; v: HomeData }; __dscHomeP?: Promise<HomeData> | null };

const timeout = <T,>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

async function resolveImages(uris: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo = Array.from(new Set(uris.filter(Boolean)));
  try {
    const keys = await Promise.all(todo.map(uriKey));
    const map = await resolveKeys(keys);
    todo.forEach((u, i) => { const id = map[keys[i]]; out.set(u, id && STORE_ID_RE.test(id) ? storeSrc(id) : ""); });
  } catch { /* unmoderated ⇒ PairArt monogram */ }
  for (const u of uris) if (!out.has(u)) out.set(u, "");
  return out;
}

export const EMPTY_HOME: HomeData = { at: 0, coins: [], hero: null, heroMode: "empty", next: [], chips: [] };

async function build(): Promise<HomeData> {
  const now = Date.now();
  if (!isDeployed()) return { ...EMPTY_HOME, at: now };
  const pc = publicClient() as PublicClient;
  const [launches] = await Promise.all([
    listLaunches(pc, resolveImages),
    indexTrades(4_000).catch(() => null), // short catch-up, like /api/trades
  ]);
  // known test coins never reach the home (lib/home/hiddenCoins); their data is untouched
  const list = launches.filter((x) => !isHiddenCoin(x.token)).slice(0, MAX_COINS);
  const fillsBy = await Promise.all(list.map((c) => tradesOf(c.token, null, FILLS_CAP, "desc").catch(() => [])));
  const coins: HomeCoin[] = list.map((x, i) => {
    const fills = fillsBy[i];
    return {
      token: x.token.toLowerCase(), name: x.name, ticker: x.ticker, pair: pairOf(x.quote), pairSym: pairSymOf(x.quote),
      icon: x.imageURI, creator: shortHex(x.creator), creatorAddr: String(x.creator).toLowerCase(), mcapUsd: x.mcapUsd, graduated: x.graduated, progressBps: x.progressBps ?? undefined, block: Number(x.block),
      launchedAt: null,
      stats: statsFromFills(fills, now, x.mcapUsd, fills.length >= FILLS_CAP),
    };
  });
  const pick = pickHero(coins);
  // launch time (age) for the hero + strip
  const need = [pick.hero, ...pick.next].filter(Boolean) as string[];
  await Promise.all(need.map(async (t) => {
    const c = coins.find((x) => x.token === t);
    if (!c) return;
    const b = await pc.getBlock({ blockNumber: BigInt(c.block) }).catch(() => null);
    if (b) c.launchedAt = Number(b.timestamp) * 1000;
  }));
  const heroIdx = list.findIndex((x) => x.token.toLowerCase() === pick.hero);
  const chips = heroIdx >= 0
    ? [...fillsBy[heroIdx]].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex).slice(0, 6).map(chipOf)
    : [];
  return { at: now, coins, ...pick, chips };
}

/** Home data, cached CACHE_MS; never throws (empty state on failure). */
export async function getHomeData(budgetMs = 9_000): Promise<HomeData> {
  const c = g.__dscHome;
  if (c && Date.now() - c.at < CACHE_MS) return c.v;
  g.__dscHomeP ??= build()
    .then((v) => { g.__dscHome = { at: Date.now(), v }; return v; })
    .catch((e) => { console.warn("[home] build failed", (e as Error).message); return c?.v ?? { ...EMPTY_HOME, at: Date.now() }; })
    .finally(() => { g.__dscHomeP = null; });
  return timeout(g.__dscHomeP, budgetMs, c?.v ?? { ...EMPTY_HOME, at: Date.now() });
}

import "server-only";
/**
 * App home data (trending hero + feed stats), server side. Sources, nothing else:
 *  - coins: lib/events listLaunches (Launched events + live curve / MarketLens mcap, graduated, moderated image)
 *  - trades: the KV trade index (lib/server/trades: indexTrades catch-up + tradesOf), the same fills /api/trades serves
 *  - age: the launch block's timestamp (RPC), hero + strip only
 * Known test coins (lib/home/hiddenCoins) are left out before anything is ranked.
 * Cached in-process for CACHE_MS; every step is time-boxed so a slow RPC degrades to the newest coin / empty state.
 */
import { coinLooksOf } from "./coinLooks";
import type { CoinLook } from "@/lib/coinLook";
import { parseAbi, type Address, type PublicClient } from "viem";
import { isDeployed } from "@/lib/chains";
import { listLaunches } from "@/lib/events";
import { publicClient } from "@/lib/protocol-viem";
import { storeSrc, STORE_ID_RE, uriKey } from "@/lib/coinImages";
import { pairOf, pairSymOf, shortHex } from "@/lib/home/pairs";
import { pairLogoBySymbol } from "@/lib/whitelistQuotes";
import { isHiddenCoin } from "@/lib/home/hiddenCoins";
import { flaggedCopySet } from "@/lib/server/nameLock";
import { chipOf, lobbyAgeTokens, pickHero, statsFromFills, type HomeCoin, type HomeData } from "@/lib/home/trending";
import { bestCalls, pilotBoard, positionBoard, rocketSeasonSp, type PositionBoard, topPilots, tickerOf, type BestCalls, type BoardOpts, type PilotBoard, type TickerItem, type TopPilots } from "@/lib/home/topPilots";
import { levelInfo } from "@/lib/xp";
import { seasonAt } from "@/lib/duel/season";
import { resolveKeys } from "./imageStore";
import { usernameOf } from "./usernames";
import { ledgerOf, totals } from "./xp";
import { indexTrades, tradesOf } from "./trades";

const CACHE_MS = 15_000;
const FILLS_CAP = 2000;
const MAX_COINS = 120;
const g = globalThis as unknown as { __dscHome?: { at: number; v: HomeData }; __dscHomeP?: Promise<HomeData> | null; __dscBoard?: { at: number; v: PilotBoard }; __dscPositions?: { at: number; v: PositionBoard }; __dscRocketSp?: { at: number; season: string; v: Record<string, number> } };

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

/**
 * Base pair name + logo for every rocket (maker 2026-11-19: the pair filter listed raw contracts). Listed pair coins use their
 * symbol + art; a rocket paired to another rocket uses that rocket's ticker + image; any other quote reads its ERC-20 symbol
 * once per address (cached for the process). Only a quote whose symbol can't be read keeps its short address.
 */
const erc20Sym = parseAbi(["function symbol() view returns (string)"]);
const quoteSyms = new Map<string, Promise<string | null>>();
async function namePairs(pc: PublicClient, coins: HomeCoin[], quotes: string[]): Promise<void> {
  const byToken = new Map(coins.map((c) => [c.token, c]));
  await Promise.all(coins.map(async (c, i) => {
    const logo = pairLogoBySymbol(c.pairSym);
    if (logo) { c.pairIcon = logo; return; }
    if (!c.pairSym.startsWith("0x")) return;
    const q = quotes[i].toLowerCase();
    const host = byToken.get(q);
    if (host) { c.pairSym = host.ticker.replace(/^\$/, "").toUpperCase(); if (host.icon) c.pairIcon = host.icon; return; }
    let p = quoteSyms.get(q);
    if (!p) {
      p = (pc.readContract({ address: q as Address, abi: erc20Sym, functionName: "symbol" }) as Promise<string>)
        .then((s) => (s && s.trim() ? s.trim().slice(0, 16) : null), () => null);
      quoteSyms.set(q, p);
      p.then((s) => { if (s === null) quoteSyms.delete(q); });   // retry a failed read next build
    }
    const sym = await p;
    if (sym) { c.pairSym = sym.toUpperCase(); const l = pairLogoBySymbol(sym); if (l) c.pairIcon = l; }
  }));
}

export const EMPTY_HOME: HomeData = { at: 0, coins: [], hero: null, heroMode: "empty", next: [], chips: [] };

/** `next dev` only: DSC_HOME_FIXTURE=<path to a HomeData JSON> paints the lobby with it (layout QA without a chain). */
async function devFixture(): Promise<HomeData | null> {
  if (process.env.NODE_ENV !== "development" || !process.env.DSC_HOME_FIXTURE) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const d = JSON.parse(await readFile(process.env.DSC_HOME_FIXTURE, "utf8")) as HomeData;
    return { ...d, at: Date.now() };
  } catch { return null; }
}

async function build(): Promise<HomeData> {
  const now = Date.now();
  const fx = await devFixture();
  if (fx) return fx;
  if (!isDeployed()) return { ...EMPTY_HOME, at: now };
  const pc = publicClient() as PublicClient;
  const [launches] = await Promise.all([
    listLaunches(pc, resolveImages),
    indexTrades(4_000).catch(() => null), // short catch-up, like /api/trades
  ]);
  // known test coins never reach the home (lib/home/hiddenCoins); their data is untouched
  // slipped-in name+ticker copies (lib/server/nameLock) are hidden from the feed / lists / search; data is not deleted
  const copies = await flaggedCopySet(launches.map((x) => x.token)).catch(() => new Set<string>());
  const list = launches.filter((x) => !isHiddenCoin(x.token) && !copies.has(x.token.toLowerCase())).slice(0, MAX_COINS);
  const fillsBy = await Promise.all(list.map((c) => tradesOf(c.token, null, FILLS_CAP, "desc").catch(() => [])));
  const coins: HomeCoin[] = list.map((x, i) => {
    const fills = fillsBy[i];
    return {
      token: x.token.toLowerCase(), name: x.name, ticker: x.ticker, pair: pairOf(x.quote), pairSym: pairSymOf(x.quote),
      icon: x.imageURI, creator: shortHex(x.creator), creatorAddr: String(x.creator).toLowerCase(), mcapUsd: x.mcapUsd, graduated: x.graduated, progressBps: x.progressBps ?? undefined, block: Number(x.block),
      launchedAt: null, mode: x.mode,
      stats: statsFromFills(fills, now, x.mcapUsd, fills.length >= FILLS_CAP),
    };
  });
  await timeout(namePairs(pc, coins, list.map((x) => String(x.quote ?? ""))).catch(() => {}), 2_000, undefined);
  // each coin's launch look (lib/coinLook), for the cards, the pad and the hero
  const looks = await timeout(coinLooksOf(coins.map((c) => c.token)).catch(() => ({} as Record<string, CoinLook>)), 1_500, {} as Record<string, CoinLook>);
  for (const c of coins) if (looks[c.token]) c.look = looks[c.token];
  const pick = pickHero(coins);
  // launch time (age) for the hero, the trending list and the newest launches (lobby shelves)
  const need = lobbyAgeTokens(coins, pick);
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
  // board guardrails need who launched each rocket and which reached orbit (lib/home/topPilots BOARD_RULES)
  const opts: BoardOpts = { creators: new Map(list.map((x) => [x.token.toLowerCase(), String(x.creator).toLowerCase()])), graduated: new Set(list.filter((x) => x.graduated).map((x) => x.token.toLowerCase())) };
  const pilots = topPilots(fillsBy, now, 5, opts);
  const calls = bestCalls(fillsBy, now, opts);
  for (const k of Object.keys(calls) as (keyof BestCalls)[]) { const c = calls[k]; if (c) c.coinName = coins.find((x) => x.token === c.coin)?.ticker ?? ""; }
  // the full /leaderboard (lib/server/leaderboard) ranks from the same fills; kept server side, not in HomeData
  g.__dscBoard = { at: now, v: pilotBoard(fillsBy, now, opts) };
  g.__dscPositions = { at: now, v: positionBoard(fillsBy, now, opts) };
  const season = seasonAt(now);
  g.__dscRocketSp = { at: now, season: season.id, v: rocketSeasonSp(fillsBy, now, season.startsAt, season.endsAt, opts) };
  const ticker = tickerOf(fillsBy, new Map(coins.map((c) => [c.token, c.name])));
  await timeout(namePilots(pilots, ticker, calls), 2_500, undefined);
  return { at: now, coins, ...pick, chips, pilots, bestCalls: calls, ticker };
}

/** Usernames + levels for the Top pilots and ticker traders (KV). Mutates; a miss leaves the default name. */
async function namePilots(pilots: TopPilots, ticker: TickerItem[], calls?: BestCalls): Promise<void> {
  const callRows = calls ? [calls.day, calls.week, calls.month].filter((c): c is NonNullable<typeof c> => !!c) : [];
  const rows = [...pilots.day, ...pilots.week, ...pilots.month, ...callRows];
  const wallets = Array.from(new Set([...rows.map((r) => r.wallet), ...ticker.map((t) => t.trader)]));
  const names = new Map<string, string | null>();
  const levels = new Map<string, { level: number; prestige: number }>();
  const ranked = new Set(rows.map((r) => r.wallet));
  await Promise.all(wallets.map(async (w) => {
    names.set(w, await usernameOf(w).catch(() => null));
    if (!ranked.has(w)) return;
    const l = await ledgerOf(w).then((x) => { const t = totals(x); return levelInfo(t.total, t.prestige); }).catch(() => null);
    if (l) levels.set(w, { level: l.level, prestige: l.prestige });
  }));
  for (const r of rows) { r.username = names.get(r.wallet) ?? null; const l = levels.get(r.wallet); r.level = l?.level ?? null; r.prestige = l?.prestige ?? null; }
  for (const t of ticker) t.username = names.get(t.trader) ?? null;
}

/** Every pilot's numbers per window (lib/home/topPilots pilotBoard), from the last home build; null before the first. */
export async function getPilotBoard(budgetMs = 9_000): Promise<PilotBoard | null> {
  await getHomeData(budgetMs);
  return g.__dscBoard?.v ?? null;
}

/** Each window's best single cash-outs (lib/home/topPilots positionBoard), from the last home build; null before the first. */
export async function getPositionBoard(budgetMs = 9_000): Promise<PositionBoard | null> {
  await getHomeData(budgetMs);
  return g.__dscPositions?.v ?? null;
}

/** This season's Rockets SP per wallet (lib/season/points), from the last home build; {} before the first. */
export async function getRocketSeasonSp(budgetMs = 9_000): Promise<Record<string, number>> {
  await getHomeData(budgetMs);
  const c = g.__dscRocketSp;
  return c && c.season === seasonAt(Date.now()).id ? c.v : {};
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

import "server-only";
/**
 * /leaderboard data (round 2 "Top pilots" board): the lobby shelf's numbers all the way down. Ranks the pilot board
 * built with the home data (lib/server/home getPilotBoard: the same indexed fills), names the top rows (username +
 * level, KV) and finds the asking pilot's own rank. Cached per window+sort for CACHE_MS.
 */
import { levelInfo } from "@/lib/xp";
import { BOARD_WINDOWS, crewBoard, gapToNext, rankBoard, type BestCall, type BoardPilot, type BoardPosition, type BoardSort, type BoardWindow, type CrewRow } from "@/lib/home/topPilots";
import { pfpUrl } from "@/lib/profileMeta";
import { getHomeData, getPilotBoard, getPositionBoard, getRocketSeasonSp, getRocketWeekSp } from "./home";
import { weekModeSp } from "./weekly";
import { lastWeekAt, weekAt, type Week } from "@/lib/season/weekly";
import { metaOf } from "./profileMeta";
import { climbBoard, modeSp } from "./seasonModes";
import { LEAGUES, leagueOf, rankSeasonAt, seasonAt } from "@/lib/duel/season";
import { kv } from "./kv";
import { addLife, finishedLife, snapSeason } from "./lifetime";
import { RANK_MODES, totalSp, type ModeSp } from "@/lib/season/points";
import { guildTagsOf } from "./guilds";
import { usernameOf } from "./usernames";
import { equippedOf } from "./collection";
import { ledgerOf, totals } from "./xp";

export const BOARD_TOP = 50;
const CACHE_MS = 15_000;

/** A rocket the rows name: ticker and its moderated image ("" ⇒ initial). */
export type BoardCoin = { ticker: string; icon: string };
/** Pilot face on the board: profile picture URL ("" ⇒ initial). */
/** skin: the pilot's equipped hull skin id (lib/collection skinArt), drawn beside the name on the boards (maker 2026-11-18). */
export type Named = { pfp?: string; skin?: string };

export type BoardResponse = {
  window: BoardWindow;
  sort: BoardSort;
  rows: (BoardPilot & Named & { rank: number })[];
  /** every rocket the rows name */
  coins: Record<string, BoardCoin>;
  /** how many pilots each window has under this sort (the page opens on the shortest window with anyone in it) */
  counts: Record<BoardWindow, number>;
  me: (BoardPilot & Named & { rank: number; gap: number }) | null;
  /** the window's Best call (All time shows the month's) */
  bestCall: BestCall | null;
};

/** GET /api/leaderboard?sort=crews: crews ranked for the window, and the asking pilot's crew rank. */
export type CrewBoardResponse = { window: BoardWindow; sort: "crews"; crews: (CrewRow & { rank: number })[]; mine: (CrewRow & { rank: number }) | null; bestCall: BestCall | null };

async function bestCallFor(window: BoardWindow): Promise<BestCall | null> {
  const h = await getHomeData();
  return h.bestCalls?.[window === "all" ? "month" : window] ?? null;
}

/** Pilots of a window, all rows (unsorted), for crew sums: at most this many wallets are looked up. */
const CREW_WALLETS_MAX = 2000;
export async function getCrewBoard(window: BoardWindow, me: string | null): Promise<CrewBoardResponse> {
  const board = await getPilotBoard();
  const rows = (board?.[window] ?? []).slice().sort((a, b) => b.orbits - a.orbits || b.green - a.green || b.pnlUsd - a.pnlUsd).slice(0, CREW_WALLETS_MAX);
  const wallets = rows.map((r) => r.wallet);
  if (me) wallets.push(me.toLowerCase());
  const tags = await guildTagsOf(wallets);
  const crews = crewBoard(rows, tags).map((c, i) => ({ ...c, rank: i + 1 }));
  const myTag = me ? tags[me.toLowerCase()] : null;
  return { window, sort: "crews", crews: crews.slice(0, BOARD_TOP), mine: myTag ? crews.find((c) => c.id === myTag.id) ?? null : null, bestCall: await bestCallFor(window) };
}

type Ranked = { at: number; ranked: BoardPilot[]; counts: Record<BoardWindow, number>; named: (BoardPilot & Named)[] };
const g = globalThis as unknown as { __dscBoardRanked?: Map<string, Ranked> };

async function name<T extends { wallet: string }>(rows: T[]): Promise<(T & Named & { username: string | null; level: number | null; prestige: number | null; crew: string | null })[]> {
  return Promise.all(rows.map(async (r) => {
    const [username, l, meta, skin] = await Promise.all([
      usernameOf(r.wallet).catch(() => null),
      ledgerOf(r.wallet).then((x) => { const t = totals(x); return levelInfo(t.total, t.prestige); }).catch(() => null),
      metaOf(r.wallet).catch(() => null),
      equippedOf(r.wallet).then((e) => e.skin).catch(() => ""),
    ]);
    return { ...r, username, level: l?.level ?? null, prestige: l?.prestige ?? null, pfp: meta ? pfpUrl(meta.pfp) : "", skin };
  })).then(async (named) => {
    const tags = await guildTagsOf(named.map((r) => r.wallet));
    return named.map((r) => ({ ...r, crew: tags[r.wallet]?.tag ?? null }));
  });
}

export async function getLeaderboard(window: BoardWindow, sort: BoardSort, me: string | null): Promise<BoardResponse> {
  const key = `${window}:${sort}`;
  const cache: Map<string, Ranked> = (g.__dscBoardRanked ??= new Map<string, Ranked>());
  let c: Ranked | undefined = cache.get(key);
  if (!c || Date.now() - c.at > CACHE_MS) {
    const board = await getPilotBoard();
    const counts = Object.fromEntries(BOARD_WINDOWS.map((w) => [w.k, board ? rankBoard(board[w.k], sort).length : 0])) as Record<BoardWindow, number>;
    const ranked = board ? rankBoard(board[window], sort) : [];
    c = { at: Date.now(), ranked, counts, named: await name(ranked.slice(0, BOARD_TOP)) };
    cache.set(key, c);
  }
  const rows = c.named.map((r, i) => ({ ...r, rank: i + 1 }));
  let mine: BoardResponse["me"] = null;
  const lc = me?.toLowerCase();
  if (lc) {
    const i = c.ranked.findIndex((r) => r.wallet === lc);
    if (i >= 0) {
      const [named] = i < BOARD_TOP ? [c.named[i]] : await name([c.ranked[i]]);
      mine = { ...named, rank: i + 1, gap: gapToNext(c.ranked, i, sort) };
    }
  }
  return { window, sort, rows, coins: await coinsOf([...rows, ...(mine ? [mine] : [])].flatMap((r) => r.coins ?? [])), counts: c.counts, me: mine, bestCall: null };
}

async function coinsOf(tokens: string[]): Promise<Record<string, BoardCoin>> {
  const want = new Set(tokens);
  const out: Record<string, BoardCoin> = {};
  if (!want.size) return out;
  const h = await getHomeData();
  for (const c of h.coins) if (want.has(c.token)) out[c.token] = { ticker: c.ticker, icon: c.icon ?? "" };
  return out;
}

/** GET /api/leaderboard?sort=positions: the window's biggest single cash-outs. */
export type PositionsResponse = { window: BoardWindow; sort: "positions"; rows: (BoardPosition & Named & { rank: number; username: string | null })[]; coins: Record<string, BoardCoin> };
const gp = globalThis as unknown as { __dscPosNamed?: Map<BoardWindow, { at: number; v: PositionsResponse }> };
export async function getPositions(window: BoardWindow): Promise<PositionsResponse> {
  const cache = (gp.__dscPosNamed ??= new Map());
  const hit = cache.get(window);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const board = await getPositionBoard();
  const top = (board?.[window] ?? []).slice(0, BOARD_TOP);
  // one name lookup per wallet, however many rows it has
  const faces = new Map((await name([...new Map(top.map((p) => [p.wallet, { wallet: p.wallet }])).values()])).map((x) => [x.wallet, x]));
  const rows = top.map((p, i) => ({ ...p, rank: i + 1, username: faces.get(p.wallet)?.username ?? null, pfp: faces.get(p.wallet)?.pfp ?? "" }));
  const v: PositionsResponse = { window, sort: "positions", rows, coins: await coinsOf(rows.map((r) => r.coin)) };
  cache.set(window, { at: Date.now(), v });
  return v;
}

/* ── Overall + mode ranks (maker 2026-11-18): one season ladder, SP from every mode (lib/season/points) ─────────────── */

type Face = Named & { wallet: string; username: string | null; level: number | null };
/** prev: the tier this pilot finished last season on (Bronze and up), kept as a badge after the reset (maker 2026-11-18). */
export type OverallRow = Face & { rank: number; pts: number; league: string; by: ModeSp; prev?: string };
/** tiers: how many ranked pilots sit in each tier this season, for the tier filter (LoL-style). */
export type OverallResponse = { sort: "overall"; season: { n: number; endsAt: number }; rows: OverallRow[]; total: number; me: OverallRow | null; tiers: Record<string, number> };
const go = globalThis as unknown as { __dscOverall?: { at: number; ranked: { wallet: string; pts: number; by: ModeSp }[]; named: OverallRow[]; tiers: Record<string, number>; prev: Record<string, string> } };

/* Season standings snapshot: each refresh rewrites this season's { wallet: tier } (Bronze and up), so the last write before
   the season ends is the final standing. The next season reads it back for the last-season badge. */
const FINAL = (seasonId: string) => `season:final:${seasonId}`;
async function lastSeasonTiers(n: number): Promise<Record<string, string>> {
  if (n <= 1) return {};
  try { const v = await kv().get(FINAL(`s${n - 1}`)); return v ? (JSON.parse(v) as Record<string, string>) : {}; } catch { return {}; }
}

export async function getOverall(me: string | null): Promise<OverallResponse> {
  const now = Date.now(), season = seasonAt(now);
  let c = go.__dscOverall;
  if (!c || now - c.at > CACHE_MS) {
    const [rockets, duel, royale, climb] = await Promise.all([getRocketSeasonSp(), modeSp("duel").catch(() => ({})), modeSp("royale").catch(() => ({})), modeSp("climb").catch(() => ({}))]);
    const per = { rockets, duel, royale, climb } as Record<(typeof RANK_MODES)[number], Record<string, number>>;
    const m = new Map<string, ModeSp>();
    for (const k of RANK_MODES) for (const [w, v] of Object.entries(per[k])) if (v > 0) { const r = m.get(w) ?? {}; r[k] = v; m.set(w, r); }
    const ranked = [...m.entries()].map(([wallet, by]) => ({ wallet, by, pts: totalSp(by) })).sort((a, b) => b.pts - a.pts || a.wallet.localeCompare(b.wallet));
    const prev = await lastSeasonTiers(season.n);
    const named = (await name(ranked.slice(0, BOARD_TOP))).map((r, i) => ({ ...r, rank: i + 1, league: leagueOf(r.pts).id, ...(prev[r.wallet] ? { prev: prev[r.wallet] } : {}) }));
    const tiers: Record<string, number> = Object.fromEntries(LEAGUES.map((l) => [l.id, 0]));
    const final: Record<string, string> = {};
    for (const x of ranked) { const id = leagueOf(x.pts).id; tiers[id]++; if (id !== LEAGUES[0].id) final[x.wallet] = id; }
    // the pre-season board (lib/duel/season PRESEASON) is never sealed: Season 1 starts everyone at 0
    if (!rankSeasonAt(now).pre) {
      void kv().set(FINAL(season.id), JSON.stringify(final)).catch(() => {});
      void snapSeason(season.id, ranked).catch(() => {});
    }
    c = { at: now, ranked, named, tiers, prev };
    go.__dscOverall = c;
  }
  let mine: OverallRow | null = null;
  const lc = me?.toLowerCase();
  if (lc) {
    const i = c.ranked.findIndex((r) => r.wallet === lc);
    if (i >= 0) mine = i < BOARD_TOP ? c.named[i] : { ...(await name([c.ranked[i]]))[0], rank: i + 1, league: leagueOf(c.ranked[i].pts).id, ...(c.prev[lc] ? { prev: c.prev[lc] } : {}) };
  }
  return { sort: "overall", season: { n: season.n, endsAt: season.endsAt }, rows: c.named, total: c.ranked.length, me: mine, tiers: c.tiers };
}

/** Royale (SP by place) and Climb (best level, then fastest clear) boards, this season. Empty until real money. */
export type ModeRow = Face & { rank: number; pts?: number; climbLevel?: number; clearMs?: number };
export type ModeResponse = { sort: "royale" | "climb"; season: { n: number; endsAt: number }; rows: ModeRow[] };
export async function getModeBoard(mode: "royale" | "climb"): Promise<ModeResponse> {
  const season = seasonAt(Date.now());
  const raw: { wallet: string; pts?: number; climbLevel?: number; clearMs?: number }[] = mode === "climb"
    ? await climbBoard(BOARD_TOP).catch(() => [])
    : Object.entries(await modeSp("royale", BOARD_TOP).catch(() => ({} as Record<string, number>))).map(([wallet, pts]) => ({ wallet, pts }));
  const rows = (await name(raw)).map((r, i) => ({ ...r, rank: i + 1 }));
  return { sort: mode, season: { n: season.n, endsAt: season.endsAt }, rows };
}

/* ── Lifetime points (maker 2026-11-18): the airdrop ranking. Never resets; lib/server/lifetime ─────────────────────────── */

/** league: the pilot's tier this season. season: SP this season (part of pts). */
export type LifetimeRow = Face & { rank: number; pts: number; season: number; league: string };
export type LifetimeResponse = { sort: "lifetime"; season: { n: number; endsAt: number }; rows: LifetimeRow[]; total: number; me: LifetimeRow | null };
const gl = globalThis as unknown as { __dscLife?: { at: number; ranked: { wallet: string; pts: number; season: number }[]; named: LifetimeRow[] } };

async function lifeCache() {
  const now = Date.now();
  let c = gl.__dscLife;
  if (c && now - c.at <= CACHE_MS) return c;
  await getOverall(null);
  // lifetime points only start with Season 1; the pre-season board isn't part of them
  const season = seasonAt(now), cur = rankSeasonAt(now).pre ? [] : go.__dscOverall?.ranked ?? [];
  const finished = await finishedLife(season.n).catch(() => ({}));
  const ranked = addLife(finished, cur);
  const named = (await name(ranked.slice(0, BOARD_TOP))).map((r, i) => ({ ...r, rank: i + 1, league: leagueOf(r.season).id }));
  c = { at: now, ranked, named };
  gl.__dscLife = c;
  return c;
}

export async function getLifetime(me: string | null): Promise<LifetimeResponse> {
  const season = seasonAt(Date.now()), c = await lifeCache();
  return { sort: "lifetime", season: { n: season.n, endsAt: season.endsAt }, rows: c.named, total: c.ranked.length, me: me ? await lifetimeOf(me) : null };
}

/** One pilot's lifetime points, rank and tier (profile, points card). null = no points yet. */
export async function lifetimeOf(wallet: string): Promise<LifetimeRow | null> {
  const lc = wallet.toLowerCase(), c = await lifeCache();
  const i = c.ranked.findIndex((r) => r.wallet === lc);
  if (i < 0) return null;
  if (i < BOARD_TOP) return c.named[i];
  return { ...(await name([c.ranked[i]]))[0], rank: i + 1, league: leagueOf(c.ranked[i].season).id };
}

/* ── Weekly (spectate + weekly board thread, 2026-11-21): this UTC week's points from every mode, lib/season/weekly ──────── */

export type WeeklyRow = Face & { rank: number; pts: number; by: ModeSp };
/** last: last week's top three (the podium kept up top through the week). */
export type WeeklyResponse = { sort: "weekly"; week: Week; rows: WeeklyRow[]; total: number; me: WeeklyRow | null; last: WeeklyRow[] };
type WeekRanked = { wallet: string; pts: number; by: ModeSp }[];
type WeekCache = { at: number; ranked: WeekRanked; named: WeeklyRow[] };
const gw = globalThis as unknown as { __dscWeek?: Map<string, WeekCache> };

async function weekRanked(week: string): Promise<WeekRanked> {
  const [rockets, duel, royale, climb] = await Promise.all([getRocketWeekSp(week), weekModeSp(week, "duel").catch(() => ({})), weekModeSp(week, "royale").catch(() => ({})), weekModeSp(week, "climb").catch(() => ({}))]);
  const per = { rockets, duel, royale, climb } as Record<(typeof RANK_MODES)[number], Record<string, number>>;
  const m = new Map<string, ModeSp>();
  for (const k of RANK_MODES) for (const [w, v] of Object.entries(per[k])) if (v > 0) { const r = m.get(w) ?? {}; r[k] = v; m.set(w, r); }
  return [...m.entries()].map(([wallet, by]) => ({ wallet, by, pts: totalSp(by) })).sort((a, b) => b.pts - a.pts || a.wallet.localeCompare(b.wallet));
}
async function weekCache(week: string, top: number): Promise<WeekCache> {
  const cache: Map<string, WeekCache> = (gw.__dscWeek ??= new Map<string, WeekCache>());
  const hit = cache.get(week);
  if (hit && Date.now() - hit.at <= CACHE_MS) return hit;
  const ranked = await weekRanked(week);
  const named = (await name(ranked.slice(0, top))).map((r, i) => ({ ...r, rank: i + 1 }));
  const c: WeekCache = { at: Date.now(), ranked, named };
  cache.set(week, c);
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  return c;
}

/** How many of a finished week's pilots are sealed (the podium shows 3; the prize proposal pays up to 10). */
export const WEEK_FINAL_TOP = 10;
/** Settle window after a week ends before it's sealed: the last duels and the trade indexer catch up. */
const SEAL_AFTER_MS = 10 * 60_000;
const WEEK_FINAL = (id: string) => `week:final:${id}`;
/** A finished week's final top rows, sealed once (SET NX) so the podium and any prize read the same standings even as
 *  old fills fall out of the home build. null while the week is still settling. */
export async function weekFinal(prev: Week, now = Date.now()): Promise<WeeklyRow[] | null> {
  const s = kv();
  const got = await s.get(WEEK_FINAL(prev.id)).catch(() => null);
  if (got) { try { return JSON.parse(got) as WeeklyRow[]; } catch { /* rewrite below */ } }
  if (now < prev.endsAt + SEAL_AFTER_MS) return null;
  const rows = (await weekCache(prev.id, WEEK_FINAL_TOP)).named.slice(0, WEEK_FINAL_TOP);
  if (await s.setNX(WEEK_FINAL(prev.id), JSON.stringify(rows), 120 * 86400).catch(() => false)) return rows;
  const again = await s.get(WEEK_FINAL(prev.id)).catch(() => null);
  return again ? (JSON.parse(again) as WeeklyRow[]) : rows;
}

export async function getWeekly(me: string | null, now = Date.now()): Promise<WeeklyResponse> {
  const week = weekAt(now), prev = lastWeekAt(now);
  const [c, sealed] = await Promise.all([weekCache(week.id, BOARD_TOP), weekFinal(prev, now)]);
  const l = { named: sealed ?? (await weekCache(prev.id, 3)).named };
  let mine: WeeklyRow | null = null;
  const lc = me?.toLowerCase();
  if (lc) {
    const i = c.ranked.findIndex((r) => r.wallet === lc);
    if (i >= 0) mine = i < BOARD_TOP ? c.named[i] : { ...(await name([c.ranked[i]]))[0], rank: i + 1 };
  }
  return { sort: "weekly", week, rows: c.named, total: c.ranked.length, me: mine, last: l.named.slice(0, 3) };
}

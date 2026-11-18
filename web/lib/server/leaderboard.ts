import "server-only";
/**
 * /leaderboard data (round 2 "Top pilots" board): the lobby shelf's numbers all the way down. Ranks the pilot board
 * built with the home data (lib/server/home getPilotBoard: the same indexed fills), names the top rows (username +
 * level, KV) and finds the asking pilot's own rank. Cached per window+sort for CACHE_MS.
 */
import { levelInfo } from "@/lib/xp";
import { BOARD_WINDOWS, crewBoard, gapToNext, rankBoard, type BestCall, type BoardPilot, type BoardPosition, type BoardSort, type BoardWindow, type CrewRow } from "@/lib/home/topPilots";
import { pfpUrl } from "@/lib/profileMeta";
import { getHomeData, getPilotBoard, getPositionBoard } from "./home";
import { metaOf } from "./profileMeta";
import { guildTagsOf } from "./guilds";
import { usernameOf } from "./usernames";
import { ledgerOf, totals } from "./xp";

export const BOARD_TOP = 50;
const CACHE_MS = 15_000;

/** A rocket the rows name: ticker and its moderated image ("" ⇒ initial). */
export type BoardCoin = { ticker: string; icon: string };
/** Pilot face on the board: profile picture URL ("" ⇒ initial). */
export type Named = { pfp?: string };

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
    const [username, l, meta] = await Promise.all([
      usernameOf(r.wallet).catch(() => null),
      ledgerOf(r.wallet).then((x) => { const t = totals(x); return levelInfo(t.total, t.prestige); }).catch(() => null),
      metaOf(r.wallet).catch(() => null),
    ]);
    return { ...r, username, level: l?.level ?? null, prestige: l?.prestige ?? null, pfp: meta ? pfpUrl(meta.pfp) : "" };
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

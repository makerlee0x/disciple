import "server-only";
/**
 * /leaderboard data (round 2 "Top pilots" board): the lobby shelf's numbers all the way down. Ranks the pilot board
 * built with the home data (lib/server/home getPilotBoard: the same indexed fills), names the top rows (username +
 * level, KV) and finds the asking pilot's own rank. Cached per window+sort for CACHE_MS.
 */
import { levelInfo } from "@/lib/xp";
import { BOARD_WINDOWS, gapToNext, rankBoard, type BoardPilot, type BoardSort, type BoardWindow } from "@/lib/home/topPilots";
import { getPilotBoard } from "./home";
import { usernameOf } from "./usernames";
import { ledgerOf, totals } from "./xp";

export const BOARD_TOP = 50;
const CACHE_MS = 15_000;

export type BoardResponse = {
  window: BoardWindow;
  sort: BoardSort;
  rows: (BoardPilot & { rank: number })[];
  /** how many pilots each window has under this sort (the page opens on the shortest window with anyone in it) */
  counts: Record<BoardWindow, number>;
  me: (BoardPilot & { rank: number; gap: number }) | null;
};

type Ranked = { at: number; ranked: BoardPilot[]; counts: Record<BoardWindow, number>; named: BoardPilot[] };
const g = globalThis as unknown as { __dscBoardRanked?: Map<string, Ranked> };

async function name(rows: BoardPilot[]): Promise<BoardPilot[]> {
  return Promise.all(rows.map(async (r) => {
    const [username, l] = await Promise.all([
      usernameOf(r.wallet).catch(() => null),
      ledgerOf(r.wallet).then((x) => { const t = totals(x); return levelInfo(t.total, t.prestige); }).catch(() => null),
    ]);
    return { ...r, username, level: l?.level ?? null, prestige: l?.prestige ?? null };
  }));
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
  return { window, sort, rows, counts: c.counts, me: mine };
}

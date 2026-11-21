import "server-only";
/**
 * Weekly points on lib/server/kv (lib/season/weekly). Rockets are counted from the indexed fills (lib/server/home);
 * duel, royale and climb points are written here as they're paid.
 *   week:sp:<week>:<mode>:<wallet>  → points this week (string)
 *   week:board:<week>:<mode>        → zset wallet → points
 *   week:pair:<week>:<a>:<b>        → scoring duels this pair played this week (PAIR_CAP)
 */
import { PAIR_CAP, duelWeekPts, isWallet, weekAt } from "@/lib/season/weekly";
import type { RankMode } from "@/lib/season/points";
import { kv, type Kv } from "./kv";

const TTL = 40 * 86400; // this week and last week are read; older weeks expire
export const WK = {
  sp: (week: string, mode: RankMode, w: string) => `week:sp:${week}:${mode}:${w}`,
  board: (week: string, mode: RankMode) => `week:board:${week}:${mode}`,
  pair: (week: string, a: string, b: string) => `week:pair:${week}:${[a, b].sort().join(":")}`,
};

/** Add weekly points for one pilot (no-op for non-wallets and d <= 0). Returns their points for that mode this week. */
export async function addWeek(mode: Exclude<RankMode, "rockets">, wallet: string, d: number, s: Kv = kv(), now = Date.now()): Promise<number> {
  const w = wallet.toLowerCase(), week = weekAt(now).id;
  if (!isWallet(w) || !(d > 0)) return Number(await s.get(WK.sp(week, mode, w))) || 0;
  const pts = await s.incrByEx(WK.sp(week, mode, w), Math.round(d), TTL);
  await s.zrem(WK.board(week, mode), w);   // kv zadd is NX: drop the old score first
  await s.zadd(WK.board(week, mode), [{ score: pts, member: w }]);
  return pts;
}

/** One settled online duel (ranked or unranked). scoreA: 1 = a won. Friend and bot duels never get here. */
export async function weekDuel(a: string, b: string, scoreA: 0 | 0.5 | 1, s: Kv = kv(), now = Date.now()): Promise<void> {
  const pa = a.toLowerCase(), pb = b.toLowerCase();
  if (!isWallet(pa) || !isWallet(pb) || pa === pb) return;
  const n = await s.incrEx(WK.pair(weekAt(now).id, pa, pb), 8 * 86400);
  if (n > PAIR_CAP) return;
  await addWeek("duel", pa, duelWeekPts(scoreA), s, now);
  await addWeek("duel", pb, duelWeekPts((1 - scoreA) as 0 | 0.5 | 1), s, now);
}

/** Every wallet's points for one mode in a week (top `limit`). */
export async function weekModeSp(week: string, mode: Exclude<RankMode, "rockets">, limit = 1000, s: Kv = kv()): Promise<Record<string, number>> {
  const ids = await s.zrange(WK.board(week, mode), limit, true);
  if (!ids.length) return {};
  const vals = await s.mget(ids.map((w) => WK.sp(week, mode, w)));
  return Object.fromEntries(ids.map((w, i) => [w, Number(vals[i]) || 0]));
}

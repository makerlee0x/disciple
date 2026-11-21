import "server-only";
/**
 * Season points per mode on lib/server/kv (lib/season/points). Duel SP already lives in the duel store
 * (duel:sp / duel:sboard, written when a ranked duel settles). Royale and Climb write here once their real-money runs
 * settle on the server (ranked is real money only, maker 2026-11-17); practice and play-money runs never call these.
 *   season:sp:<season>:<mode>:<wallet>  → SP this season (string)
 *   season:board:<season>:<mode>        → zset wallet → SP
 *   season:climb:<season>               → zset wallet → best level × 1e5 − clear ms (highest level, then fastest clear)
 *   season:climbed:<season>:<wallet>:<n> → set once a level's first clear this season has paid SP
 */
import { rankSeasonAt, seasonAt } from "@/lib/duel/season";
import { climbSp, royaleSp, type RankMode } from "@/lib/season/points";
import { kv, type Kv } from "./kv";
import { addWeek } from "./weekly";

const TTL = 200 * 86400; // a 12-week season plus room to seal it into lifetime points (lib/server/lifetime); then they expire
export const SK = {
  sp: (season: string, mode: RankMode, w: string) => `season:sp:${season}:${mode}:${w}`,
  board: (season: string, mode: RankMode) => `season:board:${season}:${mode}`,
  climb: (season: string) => `season:climb:${season}`,
  climbed: (season: string, w: string, n: number) => `season:climbed:${season}:${w}:${n}`,
  duelSp: (season: string, w: string) => `duel:sp:${season}:${w}`,
  duelBoard: (season: string) => `duel:sboard:${season}`,
};

async function addSp(mode: RankMode, wallet: string, d: number, s: Kv, now: number) {
  const season = rankSeasonAt(now).id, w = wallet.toLowerCase();
  if (!(d > 0)) return Number(await s.get(SK.sp(season, mode, w))) || 0;
  const pts = await s.incrByEx(SK.sp(season, mode, w), Math.round(d), TTL);
  await s.zrem(SK.board(season, mode), w);
  await s.zadd(SK.board(season, mode), [{ score: pts, member: w }]);
  if (mode !== "rockets") await addWeek(mode, w, d, s, now).catch((e) => console.error("[week]", e));   // the weekly board (lib/server/weekly)
  return pts;
}

/** A settled real-money royale: SP by final place. Returns the pilot's royale SP this season. */
export async function awardRoyale(wallet: string, place: number, s: Kv = kv(), now = Date.now()) {
  return addSp("royale", wallet, royaleSp(place), s, now);
}

/** A cleared real-money climb level: SP the first time this season, and the climb board keeps the best level / clear. */
export async function awardClimbClear(wallet: string, level: number, clearMs: number, s: Kv = kv(), now = Date.now()) {
  const season = rankSeasonAt(now).id, w = wallet.toLowerCase();
  const score = Math.floor(level) * 1e5 - Math.max(0, Math.min(99_999, Math.round(clearMs)));
  const was = Number(await s.get(`${SK.climb(season)}:${w}`)) || -Infinity;
  if (score > was) { await s.zrem(SK.climb(season), w); await s.zadd(SK.climb(season), [{ score, member: w }]); await s.set(`${SK.climb(season)}:${w}`, String(score)); }
  const first = await s.setNX(SK.climbed(season, w, level), "1", TTL);
  return addSp("climb", wallet, first ? climbSp(level) : 0, s, now);
}

/** Every wallet's SP for one mode this season (top `limit` by SP). Duel reads the duel store's ladder. */
export async function modeSp(mode: Exclude<RankMode, "rockets">, limit = 1000, s: Kv = kv(), now = Date.now()): Promise<Record<string, number>> {
  const season = (mode === "duel" ? seasonAt(now) : rankSeasonAt(now)).id;
  const zk = mode === "duel" ? SK.duelBoard(season) : SK.board(season, mode);
  const ids = await s.zrange(zk, limit, true);
  if (!ids.length) return {};
  const vals = await s.mget(ids.map((w) => (mode === "duel" ? SK.duelSp(season, w) : SK.sp(season, mode, w))));
  return Object.fromEntries(ids.map((w, i) => [w, Number(vals[i]) || 0]));
}

/** This season's climb board: best level, then fastest clear. */
export async function climbBoard(limit = 50, s: Kv = kv(), now = Date.now()): Promise<{ wallet: string; climbLevel: number; clearMs: number }[]> {
  const season = rankSeasonAt(now).id;
  const ids = await s.zrange(SK.climb(season), limit, true);
  if (!ids.length) return [];
  const vals = await s.mget(ids.map((w) => `${SK.climb(season)}:${w}`));
  return ids.map((w, i) => { const sc = Number(vals[i]) || 0, level = Math.ceil(sc / 1e5); return { wallet: w, climbLevel: level, clearMs: level * 1e5 - sc }; });
}

import "server-only";
/**
 * Daily flight board (Free play). One scored run per device per day, verified by replaying its input log on the
 * server (lib/sim/daily.verifyDaily); the client's own number is never stored. No sign-in: a device id (random, kept in
 * the browser) is hashed into a public run id, which is what a challenge link carries. The pilot's name on the board is
 * the default call sign of that run id (lib/defaultUsername), so nothing typed by a player is ever shown.
 *
 * Keys: daily:{id}:z (zset run id → multiple), daily:{id}:run:{runId} (the verified run, 30 days),
 * daily:{id}:owner:{runId} (the wallet that saved the run's XP after signing in: its username and level then show).
 */
import { createHash } from "crypto";
import { kv, type Kv } from "./kv";
import { defaultUsername } from "../defaultUsername";
import { usernameOf } from "./usernames";
import { levelOfWallet } from "./xp";
import { dailySeed, dailyToday, dailyEndsAt, verifyDaily, validInputs, DAILY, type DailyScore } from "../sim/daily";
import type { PlayerInput } from "../sim/run";

const RUN_TTL_S = 30 * 86_400;
/** a run that started before 00:00 UTC may still be submitted for this long after the day turns */
export const DAILY_GRACE_MS = 10 * 60_000;
export const runIdOf = (device: string) => createHash("sha256").update("disciple:daily:" + device).digest("hex").slice(0, 16);
export const nameOf = (runId: string) => defaultUsername("0x" + createHash("sha256").update("disciple:pilot:" + runId).digest("hex").slice(0, 40));
const zkey = (id: number) => `daily:${id}:z`, rkey = (id: number, run: string) => `daily:${id}:run:${run}`, okey = (id: number, run: string) => `daily:${id}:owner:${run}`;

export interface DailyRun { runId: string; name: string; score: DailyScore; at: number; inputs: PlayerInput[] }
export interface DailyBoard {
  id: number; seed: number; difficulty: string; endsAt: number; count: number;
  top: { runId: string; name: string; multiple: number; pnl: number }[];
  me: { runId: string; rank: number; multiple: number; pnl: number; topPct: number } | null;
  run: { runId: string; name: string; level: number | null; prestige: number; multiple: number; pnl: number; goals: DailyScore["goals"]; boardedAtS: number | null; outAtS: number | null } | null;
}
/** is daily `id` open for a submission at `now` (today, or yesterday inside the grace window)? */
export function dailyOpen(id: number, now = Date.now()) {
  const today = dailyToday(); return id === today || (id === today - 1 && now < dailyEndsAt(id) + DAILY_GRACE_MS);
}
export type SubmitResult = { ok: true; run: DailyRun; rank: number; count: number; already: boolean } | { ok: false; status: number; error: string };
export async function submitDaily(id: number, device: unknown, inputs: unknown, s: Kv = kv()): Promise<SubmitResult> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, status: 400, error: "bad id" };
  if (!dailyOpen(id)) return { ok: false, status: 409, error: "This daily flight has closed." };
  if (typeof device !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(device)) return { ok: false, status: 400, error: "bad device" };
  if (!validInputs(inputs)) return { ok: false, status: 400, error: "bad run" };
  const runId = runIdOf(device), key = rkey(id, runId);
  const prev = await s.get(key);
  if (prev) { const run = JSON.parse(prev) as DailyRun; return { ok: true, run, already: true, ...(await rankOf(id, run.score.multiple, s)) }; }
  const score = verifyDaily(id, inputs as PlayerInput[]);
  const run: DailyRun = { runId, name: nameOf(runId), score, at: Date.now(), inputs: inputs as PlayerInput[] };
  if (!(await s.setNX(key, JSON.stringify(run), RUN_TTL_S))) {   // a second tab won the race: theirs is the scored run
    const won = JSON.parse((await s.get(key)) || "null") as DailyRun | null; if (!won) return { ok: false, status: 503, error: "try again" };
    return { ok: true, run: won, already: true, ...(await rankOf(id, won.score.multiple, s)) };
  }
  await s.zadd(zkey(id), [{ score: score.multiple, member: runId }]);
  return { ok: true, run, already: false, ...(await rankOf(id, score.multiple, s)) };
}
async function rankOf(id: number, multiple: number, s: Kv) {
  const [above, count] = await Promise.all([s.zcountAbove(zkey(id), multiple), s.zcard(zkey(id))]);
  return { rank: above + 1, count: Math.max(count, above + 1) };
}
export async function readRun(id: number, runId: string, s: Kv = kv()): Promise<DailyRun | null> {
  if (!/^[0-9a-f]{16}$/.test(runId)) return null;
  const v = await s.get(rkey(id, runId)); return v ? (JSON.parse(v) as DailyRun) : null;
}
export async function dailyBoard(id: number, opts: { me?: string | null; run?: string | null } = {}, s: Kv = kv()): Promise<DailyBoard> {
  const ids = await s.zrange(zkey(id), 10, true);
  const runs = ids.length ? await s.mget(ids.map((r) => rkey(id, r))) : [];
  const top = runs.flatMap((v) => { if (!v) return []; const r = JSON.parse(v) as DailyRun; return [{ runId: r.runId, name: r.name, multiple: r.score.multiple, pnl: r.score.pnl }]; });
  const count = await s.zcard(zkey(id));
  let me: DailyBoard["me"] = null, run: DailyBoard["run"] = null;
  if (opts.me) { const r = await readRun(id, opts.me, s); if (r) { const k = await rankOf(id, r.score.multiple, s); me = { runId: r.runId, rank: k.rank, multiple: r.score.multiple, pnl: r.score.pnl, topPct: topPct(k.rank, k.count) }; } }
  if (opts.run) { const r = await readRun(id, opts.run, s); if (r) { const p = await pilotOf(id, r, s);
    run = { runId: r.runId, name: p.name, level: p.level, prestige: p.prestige, multiple: r.score.multiple, pnl: r.score.pnl, goals: r.score.goals, boardedAtS: r.score.boardedAtS ?? null, outAtS: r.score.outAtS }; } }
  return { id, seed: dailySeed(id), difficulty: DAILY.difficulty, endsAt: dailyEndsAt(id), count, top, me, run };
}
/** "Top 12%": the share of today's pilots at or above this rank, rounded up, at least 1 */
export const topPct = (rank: number, count: number) => Math.max(1, Math.ceil((rank / Math.max(1, count)) * 100));

/** the wallet that saved this run (null: never claimed) */
export const ownerOf = (id: number, runId: string, s: Kv = kv()) => s.get(okey(id, runId));
/** bind a run to the wallet saving its XP: first wallet wins, for as long as the run is kept */
export async function bindOwner(id: number, runId: string, wallet: string, s: Kv = kv()): Promise<boolean> {
  const w = wallet.toLowerCase(); if (await s.setNX(okey(id, runId), w, RUN_TTL_S)) return true;
  return (await s.get(okey(id, runId))) === w;
}
/** how a run's pilot is shown: a signed-in pilot by their username and level, otherwise the run's call sign */
export async function pilotOf(id: number, r: DailyRun, s: Kv = kv()): Promise<{ name: string; level: number | null; prestige: number; progress: number }> {
  const w = await ownerOf(id, r.runId, s).catch(() => null); if (!w) return { name: r.name, level: null, prestige: 0, progress: 0 };
  const [u, lv] = await Promise.all([usernameOf(w).catch(() => null), levelOfWallet(w, s).catch(() => null)]);
  return { name: u || r.name, level: lv?.level ?? null, prestige: lv?.prestige ?? 0, progress: lv?.progress ?? 0 };
}

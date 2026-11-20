import "server-only";
/**
 * Real-money Climb runs on the server (maker 2026-11-20: "my account should be on there because I've played live money
 * in Climb"). Climb runs in the browser and its ladder lived only in localStorage, so the Climb board and Climb SP
 * (lib/server/seasonModes awardClimbClear) never heard of a run. Now:
 *   1. arm { kind: climb, climb: { level, stake } } notes the run (who, which level, the stake, when it started / ends)
 *   2. after the buzzer, the server reads the pilot's own Lighter fills for that window and works out the run's result
 *      itself (realized PnL net of fees, lib/turbo/profile's rule), never the browser's number
 *   3. a hit on the level's goal is a clear: awardClimbClear(level, ms to the goal) puts it on the board and pays SP once
 * The goal is the level's % of the stake, and the stake counted is never smaller than the biggest fill ÷ the level's
 * gear, so claiming a tiny stake while trading big can't shrink the goal.
 */
import { CLIMB_FREE, CLIMB_LEVELS, climbLevelsAt, hits } from "@/lib/climb/rules";
import type { TurboFill } from "@/lib/turbo/profile";
import { kv, type Kv } from "./kv";
import { lighterConfig } from "./lighter/config";
import { fillsOf } from "./lighter/history";
import { awardClimbClear } from "./seasonModes";

export type ClimbRun = { level: number; stake: number; startAt: number; endAt: number };
const runKey = (net: string, pid: string, id: string) => `climb:run:${net}:${pid.toLowerCase()}:${id}`;
/** fills a moment before the arm (the first press can race it) and after the buzzer (its close) still belong to the run */
const LEAD_MS = 5_000, TAIL_MS = 30_000;

export async function noteClimbRun(pid: string, id: string, run: ClimbRun, s: Kv = kv()) {
  const cfg = lighterConfig();
  await s.setNX(runKey(cfg.network, pid, id), JSON.stringify(run), 86_400);
}

/** The run's result from its fills: net PnL, the stake the goal is drawn on, the level cleared (0 = none) and when. */
export function scoreClimbRun(run: ClimbRun, fills: readonly Pick<TurboFill, "at" | "market" | "usd" | "fee" | "pnl">[]) {
  const mine = fills.filter((f) => f.market === "BTC" && f.at >= run.startAt - LEAD_MS && f.at <= run.endAt + TAIL_MS).sort((a, b) => a.at - b.at);
  const lvl = CLIMB_LEVELS.find((l) => l.n === run.level);
  if (!lvl || !mine.length) return { net: 0, stake: run.stake, cleared: 0, clearMs: 0, fills: mine.length };
  const biggest = Math.max(...mine.map((f) => f.usd));
  const stake = Math.max(run.stake, biggest / lvl.gear);
  // the same ladder the screen flew, drawn on that stake
  const ladder = climbLevelsAt(stake);
  const goalOf = (n: number) => ladder.find((x) => x.n === n)!.goal;
  let net = 0, at = 0;
  for (const f of mine) {
    net += (f.pnl ?? 0) - (f.fee ?? 0);
    if (!at && hits(net, goalOf(run.level))) at = f.at;
  }
  net = Math.round(net * 1e6) / 1e6;
  // the run's own level, or a higher level's goal beaten on the same run ("on dollars": that jumps you past the ones below)
  let cleared = hits(net, goalOf(run.level)) ? run.level : 0;
  for (const l of CLIMB_LEVELS) if (l.n > run.level && hits(net, goalOf(l.n))) cleared = Math.max(cleared, l.n - 1);
  return { net, stake, cleared, clearMs: at ? Math.max(0, at - run.startAt) : 0, fills: mine.length };
}

/** After the buzzer: score the run from Lighter and record a clear. Quiet when there's nothing to record. */
export async function settleClimbRun(pid: string, id: string, s: Kv = kv()) {
  const cfg = lighterConfig();
  if (!cfg.enabled) return null;
  const k = runKey(cfg.network, pid, id);
  // taken once: a second settle (the cron sweep, a retry) finds nothing
  const raw = await s.getDel(k).catch(() => null);
  if (!raw) return null;
  const run = JSON.parse(raw) as ClimbRun;
  if (!(run.level >= 1 && run.level < CLIMB_FREE)) return null;
  let fills: Awaited<ReturnType<typeof fillsOf>>;
  try { fills = await fillsOf(cfg, pid, 1); }
  catch (e) { await s.setNX(k, raw, 86_400).catch(() => false); throw e; }   // Lighter didn't answer: keep it for a retry
  if (!fills) return null;
  const r = scoreClimbRun(run, fills);
  if (r.cleared > 0) await awardClimbClear(pid, r.cleared, r.clearMs, s);
  console.info("[climb] run", id, { level: run.level, net: r.net, stake: r.stake, cleared: r.cleared, fills: r.fills });
  return r;
}

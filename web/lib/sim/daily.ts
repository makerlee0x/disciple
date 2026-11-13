/**
 * Daily flight (Free play): one market a day, the same for everyone, one scored run.
 *
 * Pure TS (client and server): the day number, its seed, the score of a run and the replay that verifies it. A run is a
 * pure function of (config, difficulty, seed, input log), so the server re-flies the player's input log on the default
 * config and scores what it gets; the client's own number is never trusted.
 *
 * Fair seeds: a day's seed is the first candidate (hash of the day and a counter) that passes a screen. The run must
 * have at least one tell to read, climb to at least 2× its launch, and a Reader pilot must finish it green. The screen is
 * deterministic, so every client and the server pick the same seed.
 */
import { cloneConfig, SIM_CONFIG, type DifficultyId, type SimConfig } from "./config";
import { SimRun, seedOf, type PlayerInput } from "./run";
import { flyPilot } from "./pilots";

/** Daily flight #1 is 2026-11-13 (UTC). A day turns at 00:00 UTC. */
export const DAILY_EPOCH_MS = Date.UTC(2026, 10, 13);
export const DAY_MS = 86_400_000;
export const DAILY = {
  difficulty: "pvp" as DifficultyId,   // Hard, every day (the approved boards)
  /** a scored run's input log: at most this many actions */
  maxInputs: 240,
  /** screen at most this many candidate seeds before taking the last one */
  maxCandidates: 24,
};
export const dailyIdAt = (ms: number) => Math.floor((ms - DAILY_EPOCH_MS) / DAY_MS) + 1;
export const dailyToday = () => dailyIdAt(Date.now());
/** ms when daily `id` ends (the next one starts) */
export const dailyEndsAt = (id: number) => DAILY_EPOCH_MS + id * DAY_MS;
export const dailySeconds = (cfg: SimConfig = SIM_CONFIG) => cfg.player.dailyMinutes * 60;

const seedCache = new Map<number, number>();
/** the fair, pre-screened seed of daily `id` (cached; ~2 sims per candidate, a few ms) */
export function dailySeed(id: number): number {
  const hit = seedCache.get(id); if (hit != null) return hit;
  const T = dailySeconds(); let seed = 0;
  for (let k = 0; k < DAILY.maxCandidates; k++) {
    seed = seedOf(`disciple:daily:${id}:${k}`);
    const probe = new SimRun(cloneConfig(), DAILY.difficulty, seed, { minutes: T / 60 }); let tells = 0;
    probe.on(({ event }) => { if (event?.kind === "tell") tells++; });
    while (probe.t < T) probe.step(1);
    if (tells < 1 || probe.peak < probe.cfg.launch.startMcapUsd * 2) continue;
    const reader = flyPilot(new SimRun(cloneConfig(), DAILY.difficulty, seed, { minutes: T / 60 }), "reader", T, seed);
    if (reader.pnlOf("you").total > 0) break;
  }
  seedCache.set(id, seed); return seed;
}

export interface DailyScore {
  /** cash-out multiple: what came back (sells + the bag marked at the end) / what went in; 0 if it never boarded */
  multiple: number;
  /** total PnL, $ */
  pnl: number;
  invested: number;
  /** the three run goals: finish green, cash out at 2× or better, the rocket reaches orbit */
  goals: { green: boolean; cash2x: boolean; orbit: boolean };
  /** mcap ($) where you first boarded, your best exit and the run's peak (for the result chart) */
  boardedMcap: number | null; boardedAtS: number | null; outMcap: number | null; peakMcap: number; peakAtS: number; outAtS: number | null;
}
/** score a finished run (the same function on the client and the server) */
export function scoreRun(r: SimRun): DailyScore {
  let invested = 0, boardedMcap: number | null = null, boardedAtS: number | null = null, outMcap: number | null = null, outAtS: number | null = null, bestSell = 0;
  for (const tr of r.trades) if (tr.mine) {
    if (tr.side === "buy") { invested += tr.usd; if (boardedMcap == null) { boardedMcap = tr.preMcap; boardedAtS = +tr.t.toFixed(1); } }
    else if (tr.preMcap > bestSell) { bestSell = tr.preMcap; outMcap = tr.preMcap; outAtS = +tr.t.toFixed(1); }
  }
  const pnl = r.pnlOf("you").total, back = invested + pnl, multiple = invested > 0 ? Math.max(0, back / invested) : 0;
  return { multiple: Math.round(multiple * 100) / 100, pnl: Math.round(pnl * 100) / 100, invested: Math.round(invested * 100) / 100,
    goals: { green: pnl > 0.005, cash2x: multiple >= 2, orbit: r.m.gradAt != null }, boardedMcap, boardedAtS, outMcap, peakMcap: Math.round(r.peak), peakAtS: +r.peakT.toFixed(1), outAtS };
}

/** a submitted input log, checked: trades only (no tramps or walls in Free play), in block order, inside the run */
export function validInputs(x: unknown, seconds = dailySeconds()): x is PlayerInput[] {
  if (!Array.isArray(x) || x.length > DAILY.maxInputs) return false;
  const N = Math.round(seconds / SIM_CONFIG.market.blockS); let last = 0;
  for (const i of x) {
    if (!i || typeof i !== "object") return false;
    const o = i as Record<string, unknown>;
    if (o.op !== "trade" || (o.side !== "buy" && o.side !== "sell")) return false;
    if (!Number.isInteger(o.blk) || (o.blk as number) < last || (o.blk as number) > N) return false;
    if (typeof o.usd !== "number" || !Number.isFinite(o.usd) || o.usd < 0 || o.usd > 1e6) return false;
    if (o.frac != null && (typeof o.frac !== "number" || !(o.frac > 0 && o.frac <= 1))) return false;
    const keys = Object.keys(o); if (keys.some((k) => !["blk", "op", "side", "usd", "frac"].includes(k))) return false;
    last = o.blk as number;
  }
  return true;
}
/** re-fly daily `id` with an input log on the default config and score it (the server's verdict) */
export function verifyDaily(id: number, inputs: PlayerInput[]): DailyScore {
  const r = SimRun.replay(cloneConfig(), DAILY.difficulty, dailySeed(id), inputs, dailySeconds(), { minutes: SIM_CONFIG.player.dailyMinutes });
  return scoreRun(r);
}

/** a cash-out multiple as the game shows it: 2.6×, 14× */
export const fmtMultiple = (m: number) => `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}×`;

export interface DailyRecap {
  score: DailyScore;
  /** the run's market cap, once a second (for the result chart and the share card) */
  path: number[];
  /** the callsign whose dump came first after the peak (and after your best exit), for the line under the chart */
  dumper: string | null; dumpAtS: number | null;
}
/** re-fly a daily run and keep what the result screen draws: the score, a 1 s mcap path and who dumped after you left */
export function dailyRecap(id: number, inputs: PlayerInput[]): DailyRecap {
  const cfg = cloneConfig(), seconds = dailySeconds(), N = Math.round(seconds / cfg.market.blockS), per = Math.round(1 / cfg.market.blockS);
  const r = new SimRun(cfg, DAILY.difficulty, dailySeed(id), { minutes: SIM_CONFIG.player.dailyMinutes });
  const path = [Math.round(r.m.mcap())]; let i = 0;
  for (;;) {
    while (i < inputs.length && inputs[i].blk === r.blk) r.apply(inputs[i++]);
    if (r.blk >= N) break; r.step(cfg.market.blockS); if (r.blk % per === 0) path.push(Math.round(r.m.mcap()));
  }
  const score = scoreRun(r), after = Math.max(score.outAtS ?? 0, score.peakAtS);   // the dump that ended the climb, after the peak and your exit
  const dump = r.events.find((e) => (e.kind === "dump" || e.kind === "rug") && e.t >= after && e.who);
  return { score, path, dumper: dump?.who ?? null, dumpAtS: dump ? +dump.t.toFixed(1) : null };
}

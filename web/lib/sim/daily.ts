/**
 * Daily flight (Free play): one market a day, the same for everyone, one scored run.
 *
 * Pure TS (client and server): the day number, its seed, the score of a run and the replay that verifies it. A run is a
 * pure function of (config, difficulty, seed, input log), so the server re-flies the player's input log on the default
 * config and scores what it gets; the client's own number is never trusted.
 *
 * Fair seeds: a day's seed is the first candidate (hash of the day, a server-only salt and a counter) that passes a
 * screen. The run must have at least one tell to read, climb to at least 2× its launch, and a Reader pilot must finish it
 * green. The salt (lib/server/dailySeed) keeps a day's market unknown until a pilot starts it: the browser gets the seed
 * with its start ticket, never from the date alone.
 *
 * Bot checks (humanFlags): a log that reacts to tells faster than a person can, bursts trades, or keeps a perfectly even
 * rhythm is still scored, but kept off the board and paid no XP.
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

const seedCache = new Map<string, number>();
/** the fair, pre-screened seed of daily `id` for a day `salt` (cached; ~2 sims per candidate, a few ms) */
export function dailySeed(id: number, salt: string): number {
  const ck = `${id}:${salt}`, hit = seedCache.get(ck); if (hit != null) return hit;
  const T = dailySeconds(); let seed = 0;
  for (let k = 0; k < DAILY.maxCandidates; k++) {
    seed = seedOf(`disciple:daily:${id}:${salt}:${k}`);
    const probe = new SimRun(cloneConfig(), DAILY.difficulty, seed, { minutes: T / 60 }); let tells = 0;
    probe.on(({ event }) => { if (event?.kind === "tell") tells++; });
    while (probe.t < T) probe.step(1);
    if (tells < 1 || probe.peak < probe.cfg.launch.startMcapUsd * 2) continue;
    const reader = flyPilot(new SimRun(cloneConfig(), DAILY.difficulty, seed, { minutes: T / 60 }), "reader", T, seed);
    if (reader.pnlOf("you").total > 0) break;
  }
  seedCache.set(ck, seed); return seed;
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

/** a submitted input log, checked: trades only (no tramps or walls in the Daily; `orders` lets a practice log keep them),
 *  in block order, inside the run */
export function validInputs(x: unknown, seconds = dailySeconds(), orders = false): x is PlayerInput[] {
  if (!Array.isArray(x) || x.length > DAILY.maxInputs) return false;
  const N = Math.round(seconds / SIM_CONFIG.market.blockS); let last = 0;
  for (const i of x) {
    if (!i || typeof i !== "object") return false;
    const o = i as Record<string, unknown>;
    if (!Number.isInteger(o.blk) || (o.blk as number) < last || (o.blk as number) > N) return false;
    if (orders && (o.op === "place" || o.op === "cancel")) {
      const fin = (k: string, lo: number, hi: number) => typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k] as number) >= lo && (o[k] as number) <= hi;
      if (o.op === "place" ? !((o.kind === "tramp" || o.kind === "wall") && fin("mcapUsd", 1, 1e12) && fin("widthPct", 0, 100) && fin("sizeUsd", 0, 1e6)) : !Number.isInteger(o.id)) return false;
      if (Object.keys(o).some((k) => !(o.op === "place" ? ["blk", "op", "kind", "mcapUsd", "widthPct", "sizeUsd"] : ["blk", "op", "id"]).includes(k))) return false;
      last = o.blk as number; continue;
    }
    if (o.op !== "trade" || (o.side !== "buy" && o.side !== "sell")) return false;
    if (typeof o.usd !== "number" || !Number.isFinite(o.usd) || o.usd < 0 || o.usd > 1e6) return false;
    if (o.frac != null && (typeof o.frac !== "number" || !(o.frac > 0 && o.frac <= 1))) return false;
    const keys = Object.keys(o); if (keys.some((k) => !["blk", "op", "side", "usd", "frac"].includes(k))) return false;
    last = o.blk as number;
  }
  return true;
}
/** re-fly a practice run (default config, 2 min, $250) and score it: what practice XP is paid on */
export function verifyPractice(difficulty: DifficultyId, seed: number, inputs: PlayerInput[]): DailyScore {
  const m = SIM_CONFIG.player.defaultMinutes; return scoreRun(SimRun.replay(cloneConfig(), difficulty, seed, inputs, m * 60, { minutes: m }));
}
/** re-fly a daily (its `seed`) with an input log on the default config and score it (the server's verdict) */
export function verifyDaily(seed: number, inputs: PlayerInput[]): DailyScore { return verifyDailyFull(seed, inputs).score; }
/** the verdict plus the bot checks on the same replay */
export function verifyDailyFull(seed: number, inputs: PlayerInput[]): { score: DailyScore; flags: string[] } {
  const r = SimRun.replay(cloneConfig(), DAILY.difficulty, seed, inputs, dailySeconds(), { minutes: SIM_CONFIG.player.dailyMinutes });
  return { score: scoreRun(r), flags: humanFlags(r, inputs) };
}

/** what a person can't do (maker 2026-11-13, "no cheating"). Thresholds leave room for fast thumbs: a masher taps ~6/s */
export const HUMAN = {
  /** reactions to tells: the first trade within `window` blocks (100 ms each) after a tell. Flag when there are at least
   *  `minReactions` and the median is `instantBlocks` or less (a person needs ~250 ms+; the Reader pilot takes 0.7–1.1 s) */
  window: 30, minReactions: 3, instantBlocks: 1,
  /** more than this many trades inside any 10 blocks (1 s) */
  maxPerSecond: 8,
  /** this many trades or more with every gap the same */
  metronome: 6,
};
export function humanFlags(r: SimRun, inputs: PlayerInput[]): string[] {
  const flags: string[] = [], B = r.cfg.market.blockS;
  const tellBlks = r.events.filter((e) => e.kind === "tell").map((e) => Math.round(e.t / B));
  const tradeBlks = inputs.filter((x) => x.op === "trade").map((x) => x.blk);
  const react = tellBlks.map((tb) => tradeBlks.find((b) => b >= tb && b <= tb + HUMAN.window)).flatMap((b, i) => (b == null ? [] : [b - tellBlks[i]])).sort((a, b) => a - b);
  if (react.length >= HUMAN.minReactions && react[Math.floor(react.length / 2)] <= HUMAN.instantBlocks) flags.push("instant");
  for (let i = 0, j = 0; i < tradeBlks.length; i++) { while (tradeBlks[i] - tradeBlks[j] >= 10) j++; if (i - j + 1 > HUMAN.maxPerSecond) { flags.push("burst"); break; } }
  if (tradeBlks.length >= HUMAN.metronome) { const g = tradeBlks.slice(1).map((b, i) => b - tradeBlks[i]); if (g[0] > 0 && g.every((x) => x === g[0])) flags.push("metronome"); }
  return flags;
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
export function dailyRecap(seed: number, inputs: PlayerInput[]): DailyRecap {
  const cfg = cloneConfig(), seconds = dailySeconds(), N = Math.round(seconds / cfg.market.blockS), per = Math.round(1 / cfg.market.blockS);
  const r = new SimRun(cfg, DAILY.difficulty, seed, { minutes: SIM_CONFIG.player.dailyMinutes });
  const path = [Math.round(r.m.mcap())]; let i = 0;
  for (;;) {
    while (i < inputs.length && inputs[i].blk === r.blk) r.apply(inputs[i++]);
    if (r.blk >= N) break; r.step(cfg.market.blockS); if (r.blk % per === 0) path.push(Math.round(r.m.mcap()));
  }
  const score = scoreRun(r), after = Math.max(score.outAtS ?? 0, score.peakAtS);   // the dump that ended the climb, after the peak and your exit
  const dump = r.events.find((e) => (e.kind === "dump" || e.kind === "rug") && e.t >= after && e.who);
  return { score, path, dumper: dump?.who ?? null, dumpAtS: dump ? +dump.t.toFixed(1) : null };
}

/**
 * PAPER TRADING (spec v0.2, /workspace/paper-trading/paper-trading-spec-v0.2.pdf): 1 player vs up to 200 bots on the
 * EXISTING simulated market (lib/sim: SimRun + Market + Pool — the curve, fee, sniper tax, graduation into the pool,
 * tramps & walls, keeper). Ported from draft PR #224 (lib/paper/*): the lobby mixes, the ONE parameterised bot brain,
 * tuning constants and personas — now a SimBrain plugged into SimRun instead of a parallel engine.
 *
 * Skill is a parameter set (spec Sec. 5): every bot runs the same decide() with its tier's params (+ archetype tell,
 * ±12% seeded jitter). Bots read only the public tape, `react` seconds late; nothing reads the player's intent or the RNG.
 * Deterministic: everything draws from the run's RNG, so (difficulty, seed, player inputs) ⇒ the same round.
 */
import { cloneConfig, DIFFICULTIES as SIM_DIFFS, type Archetype as SimArchetype, type ArchetypeId, type Difficulty as SimDifficulty, type DifficultyId, type SimConfig } from "./config";
import type { Bot, SimBrain, SimRun, SimTrade } from "./run";

export type PaperDifficulty = "easy" | "medium" | "hard";
export type Tier = "easy" | "medium" | "hard";
export type PaperArchetype = "fomo" | "paperhands" | "diamond" | "scalper" | "swinger" | "sniper" | "exit" | "dip";
export const PAPER_DIFFS: readonly PaperDifficulty[] = ["easy", "medium", "hard"];
export const PAPER_LABEL: Record<PaperDifficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };
export const PAPER_COLOR: Record<PaperDifficulty, string> = { easy: "#8ff0c0", medium: "#ffd24a", hard: "#ff6b7d" };
export const PAPER_BLURB: Record<PaperDifficulty, string> = {
  easy: "140 easy · 50 medium · 10 hard bots. Beatable: most of the table chases green and panics on red.",
  medium: "60 easy · 100 medium · 40 hard bots. Fair: scalpers and swingers ladder out of every pump.",
  hard: "20 easy · 60 medium · 120 hard bots. Super traders: snipers, exit artists and dip accumulators.",
};

/** spec Sec. 2: equal start inside a lobby */
export const START_CASH: Record<PaperDifficulty, number> = { easy: 135, medium: 500, hard: 1000 }; // Easy $100 → $135 (Oct 31, lee): the $100 lobby could not hold the $6.45K graduation raise; see docs/paper-tuning.md
/** spec Sec. 2: sample gas, $ flat per trade, out of cash (every wallet, bots too) */
export const GAS_USD = 0.25;
export const ROUND_MINUTES = 10;
/** spec Sec. 6 lobby mix for 200 bots (scaled for other counts) */
export const LOBBY_MIX: Record<PaperDifficulty, Record<Tier, number>> = {
  easy: { easy: 140, medium: 50, hard: 10 },
  medium: { easy: 60, medium: 100, hard: 40 },
  hard: { easy: 20, medium: 60, hard: 120 },
};
export const TIER_ARCHETYPES: Record<Tier, [PaperArchetype, number][]> = {
  easy: [["fomo", 0.4], ["paperhands", 0.35], ["diamond", 0.25]],
  medium: [["scalper", 0.5], ["swinger", 0.5]],
  hard: [["sniper", 0.34], ["exit", 0.33], ["dip", 0.33]],
};
export const ARCH_LABEL: Record<PaperArchetype, string> = {
  fomo: "FOMO Chaser", paperhands: "Paper Hands", diamond: "Diamond Bagholder", scalper: "Scalper", swinger: "Swinger",
  sniper: "Sniper", exit: "Exit Artist", dip: "Dip Accumulator",
};
export const RATING_BAND: Record<Tier, [number, number]> = { easy: [800, 1200], medium: [1300, 1700], hard: [1900, 2400] };
/** TUNE (ASSUMPTION, #224): bots size buys as size × SIZE_SCALE × startCash so the richer lobbies don't graduate in ~2 min
 *  (~$6.5K net buy pressure ascends the curve vs $20K–$200K gross lobby cash). Symmetric: how bots bet, not what they may do. */
/** tuning-script override only (scripts/paper-tune.mts botCashK); empty in the app */
export const BOT_CASH_K_OVERRIDE: Record<string, number> = {};
export const ELITE_N = 5, ELITE_MAX = 40, ELITE_STAKE = 1.5, SHARP_TP = 0.15, SHARP_SL = 0.3;   // eliteK > 1: round(ELITE_N·E) elites (≤ ELITE_MAX), each with E× stack, take an early position
export const LEADERS_N = 10;
export const SIZE_SCALE: Record<PaperDifficulty, number> = { easy: 0.5, medium: 0.18, hard: 0.23 }; // v3 (round ends at ascension): 0.5 / 0.18 / 0.23; // v1: 1 / 0.13 / 0.11; v2: 0.87 / 0.15 / 0.15 (Easy at $100 stacks); v2.2 medium 0.237
export const NOISE_TRADE_SHARE = 0.25;
/** PAPER-ONLY practice bonus (lee, Oct 31; NOT a feature of the real game): a fixed USDG pool per lobby, paid only if the coin
 *  ASCENDS, at that moment, as CASH (never tokens, so it can't move the chart) to the TOP 3 wallets — bots and the player alike —
 *  by score = held contribution + VOLUME_CREDIT × traded volume $, where held contribution = the cost basis of the tokens still held
 *  (heldTokens × avgEntry, average cost: a sell removes avgEntry × tokens sold, never the proceeds — profit-taking isn't penalised,
 *  dumping is), floored at 0. Score > 0 qualifies; ties → earlier first buy. */
export const ASCENSION_POOL: Record<PaperDifficulty, number> = { easy: 135, medium: 500, hard: 1000 };   // 1 × the lobby stack (2× let a wash trader beat its fees in Medium, see docs)
export const ASCENSION_TOP = 3;
export const ASCENSION_VOLUME_CREDIT = 0.1;
/** how the pool is split among the top wallets: "prorata" (to score) or fixed shares, e.g. [0.5, 0.3, 0.2] */
export const ASCENSION_SPLIT: "prorata" | number[] = "prorata";
export interface Contributor { wallet: string; contrib: number; firstT: number }
/** rank contributors (> 0, desc, ties → earlier firstT) */
export const rankContrib = (c: Contributor[]) => c.filter((x) => x.contrib > 1e-9).sort((a, b) => b.contrib - a.contrib || a.firstT - b.firstT);
/** top-N payouts; Σ = pool whenever anyone qualifies (fewer than N ⇒ the qualifiers split it all) */
export function splitPool(c: Contributor[], pool: number, split: "prorata" | number[] = ASCENSION_SPLIT, top = ASCENSION_TOP): { wallet: string; contrib: number; payout: number }[] {
  const w = rankContrib(c).slice(0, top); if (!w.length || !(pool > 0)) return [];
  const sh = split === "prorata" ? w.map((x) => x.contrib) : w.map((_, i) => split[i] ?? 0), S = sh.reduce((a, x) => a + x, 0);
  return w.map((x, i) => ({ wallet: x.wallet, contrib: x.contrib, payout: S > 0 ? pool * sh[i] / S : pool / w.length }));
}
/** One brain, parameterised (spec Sec. 5) */
export interface BrainParams {
  reactS: [number, number]; intervalS: number; noise: number; windows: number[]; vwap: boolean;
  wMom: number; wRev: number; wCurve: number; wMood: number; buyTh: number; sellTh: number;
  stop: "none" | "panic" | "fixed" | "trail"; stopPct: number; ladder: [number, number][]; scaleOutNearGrad: boolean; dipPct: number;
  size: [number, number]; maxPos: number; maxEntries: number; roundAmounts: boolean; minTradeUsd: number; curveAware: 0 | 1 | 2;
  maxHoldS: number; firstRed: boolean; neverSell: boolean; cooldownS: number; activeFrom: [number, number];
  /** ascension pool awareness (public: pool size + rule): above curve progress poolG a holder skips profit-taking sells
   *  (selling cuts its held contribution; stops still fire) when poolHold, and buys get +wPool × curve closeness to ASCEND when the
   *  bot is in, or within reach of, the public top-3 race (its contribution + one buy ≥ #3's) */
  poolG: number; poolHold: boolean; wPool: number;
  /** near ASCEND (g > poolG) a bot's max position is × poolPosK (it loads up for the finish / the race) */
  poolPosK: number;
}
const TIER_BASE: Record<Tier, BrainParams> = {
  easy: { reactS: [2, 3], intervalS: 2, noise: 0.27, windows: [2], vwap: false, wMom: 1, wRev: 0, wCurve: 0, wMood: 0.5, buyTh: 0.25, sellTh: -0.6,
    stop: "panic", stopPct: 0.35, ladder: [[0.15, 1]], scaleOutNearGrad: false, dipPct: 0, size: [0.2, 0.5], maxPos: 0.8, maxEntries: 1, roundAmounts: true,
    minTradeUsd: 0, curveAware: 0, maxHoldS: 0, firstRed: false, neverSell: false, cooldownS: 3, activeFrom: [0, 420], poolG: 0.75, poolHold: false, wPool: 0, poolPosK: 1 },
  medium: { reactS: [0.8, 1.2], intervalS: 1, noise: 0.1, windows: [5, 30], vwap: false, wMom: 0.8, wRev: 0.3, wCurve: 0.2, wMood: 0.4, buyTh: 0.3, sellTh: -0.35,
    stop: "fixed", stopPct: 0.12, ladder: [[0.25, 1 / 3], [0.5, 1 / 3]], scaleOutNearGrad: false, dipPct: 0.1, size: [0.1, 0.25], maxPos: 0.5, maxEntries: 1.4,
    roundAmounts: false, minTradeUsd: 5, curveAware: 1, maxHoldS: 0, firstRed: false, neverSell: false, cooldownS: 4, activeFrom: [8, 300], poolG: 0.75, poolHold: false, wPool: 0, poolPosK: 1 },
  hard: { reactS: [0.15, 0.25], intervalS: 0.5, noise: 0.025, windows: [3, 20, 60], vwap: true, wMom: 0.7, wRev: 0.6, wCurve: 0.5, wMood: 0.3, buyTh: 0.35, sellTh: -0.3,
    stop: "trail", stopPct: 0.08, ladder: [[0.2, 0.25], [0.4, 0.25], [0.7, 0.25]], scaleOutNearGrad: true, dipPct: 0.03, size: [0.3, 0.5], maxPos: 0.35, maxEntries: 2.6,
    roundAmounts: false, minTradeUsd: 12, curveAware: 2, maxHoldS: 0, firstRed: false, neverSell: false, cooldownS: 5, activeFrom: [8, 240], poolG: 0.75, poolHold: false, wPool: 0, poolPosK: 1 },
};
const ARCH_OVERRIDE: Record<PaperArchetype, Partial<BrainParams>> = {
  fomo: { wMom: 1.4, buyTh: 0.35, activeFrom: [0, 360] },
  paperhands: { firstRed: true, ladder: [[0.1, 1]] },
  diamond: { neverSell: true, wMom: 0.8, buyTh: 0.2, size: [0.3, 0.6] },
  scalper: { size: [0.04, 0.1], ladder: [[0.06, 0.5], [0.12, 0.5]], stopPct: 0.06, maxHoldS: 45, buyTh: 0.2 },
  swinger: { size: [0.2, 0.35], intervalS: 1.5, buyTh: 0.4, ladder: [[0.25, 1 / 3], [0.5, 1 / 3]] },
  sniper: { wMom: 1.1, wRev: 0.2, buyTh: 0.4, size: [0.45, 0.7], activeFrom: [8, 60] },
  exit: { ladder: [[0.12, 0.25], [0.25, 0.25], [0.4, 0.25], [0.6, 0.25]], wCurve: 0.9 },
  dip: { wMom: 0.2, wRev: 1.2, dipPct: 0.05, size: [0.25, 0.35] },
};
export const brainFor = (tier: Tier, arch: PaperArchetype, d?: PaperDifficulty): BrainParams => ({ ...TIER_BASE[tier], ...TUNE.tier[tier], ...ARCH_OVERRIDE[arch], ...TUNE.arch[arch], ...(d ? TUNE.lobby[d]?.[tier] : undefined) });
/** TUNING layer (balance as a config diff, spec Sec. 5 note): overrides on top of the spec table above, plus lobby-level knobs.
 *  Everything here is listed against the spec in docs/paper-tuning.md. Mutable only for scripts/paper-tune.mts. */
export const TUNE: {
  /** per-lobby, per-tier overrides (applied last): tune one lobby without moving the others */
  lobby: Partial<Record<PaperDifficulty, Partial<Record<Tier, Partial<BrainParams>>>>>;
  tier: Partial<Record<Tier, Partial<BrainParams>>>; arch: Partial<Record<PaperArchetype, Partial<BrainParams>>>;
  /** per-bot size multiplier ~ lognormal(σ), mean-normalised to 1: a few bots bet big (whales / degens), most bet small */
  aggSigma: Record<PaperDifficulty, number>;
  /** added to every phase's backdrop mood, per lobby (the demand regime's strength) */
  moodBias: Record<PaperDifficulty, number>;
  /** curve-aware sizing: a buy is capped so it moves the price at most this much (0 = off). Public info (the HUD's price-move line) */
  maxImpact: Record<Tier, number>;
} = {
  // Tuning v2 (Oct 31, scripts/paper-tune.mts + random search; rationale and every deviation from the spec table: docs/paper-tuning.md).
  // Easy bots read a 6 s window and wait ~7 s between trades (spec: 2 s / 3 s) — the 2 s herd of 140 bots made ±50% second-scale whipsaws;
  // Medium/Hard wait longer between trades (6 s / 10 s) and trade smaller minimums, so gas stops bleeding Medium and Hard stops herding.
  tier: { easy: { windows: [6], cooldownS: 6.8 }, medium: { cooldownS: 6.3, minTradeUsd: 2.4 }, hard: { cooldownS: 10, buyTh: 0.26, minTradeUsd: 5.4 } },
  arch: {},
  // v2.3 (Oct 31, approach A — bot mechanics only, decent player untouched): in the Medium and Hard lobbies bots take profit on
  // big runs (2-step ladders, Diamond hands sell too), Hard-lobby Hard bots chase momentum less (wMom 0.43) and stop entering
  // by ~280 s, Medium/Easy tiers there are pickier with smaller max positions. Found by random search on seeds 3000/5000,
  // validated on held-out 7000–7059 / 9000–9059. Easy lobby: no overrides.
  lobby: {medium: {easy: {maxPos: 0.526, buyTh: 0.358, cooldownS: 15.924, wMom: 1.351, stopPct: 0.226, ladder: [[0.756, 0.419], [1.889, 0.444]], neverSell: false, activeFrom: [8, 381]}, medium: {maxPos: 0.75, buyTh: 0.233, cooldownS: 6.989, wMom: 1.095, stopPct: 0.282, ladder: [[0.576, 0.43], [2.233, 0.654]], neverSell: false, activeFrom: [8, 363]}, hard: {maxPos: 0.686, buyTh: 0.547, cooldownS: 5.064, wMom: 1.013, stopPct: 0.168, ladder: [[0.743, 0.333], [1.284, 0.418]], neverSell: false, activeFrom: [8, 297.939]}}, hard: {easy: {maxPos: 0.384, buyTh: 0.586, cooldownS: 8.55, wMom: 1.042, stopPct: 0.301, ladder: [[0.569, 0.281], [2.328, 0.315]], neverSell: false, activeFrom: [6.052, 312]}, medium: {maxPos: 0.278, buyTh: 0.541, cooldownS: 18.26, wMom: 1.044, stopPct: 0.225, ladder: [[0.707, 0.57], [1.458, 0.553]], neverSell: false, activeFrom: [8, 252]}, hard: {maxPos: 0.811, buyTh: 0.469, cooldownS: 6.305, wMom: 0.428, stopPct: 0.277, ladder: [[0.873, 0.256], [2.033, 0.452]], neverSell: false, activeFrom: [8, 280]}}},
  aggSigma: { easy: 0.68, medium: 1.226, hard: 0.804 }, moodBias: { easy: -0.04, medium: 0.038, hard: -0.049 }, maxImpact: { easy: 0, medium: 0, hard: 0 },
};
/** backdrop phases (spec Sec. 4): mood biases every wallet's score equally; boundaries jitter ±15 s from the seed */
export const PHASES = [
  { id: "discovery", start: 0, mood: [0.0, 0.25], vol: 1 },
  { id: "first_trend", start: 90, mood: [0.2, 0.55], vol: 1.2 },
  { id: "reversal", start: 240, mood: [-0.6, -0.2], vol: 1.3 },
  { id: "chop_second_trend", start: 330, mood: [-0.2, 0.45], vol: 1.1 },
  { id: "endgame", start: 480, mood: [-0.4, 0.4], vol: 1.6 },
] as const;

/** sim difficulty / archetype ids used inside SimRun (paper entries live only in a paper run's own cfg copy) */
export const paperDiffId = (d: PaperDifficulty) => `paper-${d}` as unknown as DifficultyId;
export const paperArchId = (a: PaperArchetype) => `paper-${a}` as unknown as ArchetypeId;

/** A SimConfig for one paper lobby: the real launch params (never re-typed) + a paper difficulty + the 8 archetypes. */
export function paperConfig(d: PaperDifficulty, base: SimConfig = cloneConfig()): SimConfig {
  const c: SimConfig = JSON.parse(JSON.stringify(base));
  c.player.startBalanceUsd = START_CASH[d]; c.player.gasUsd = GAS_USD; c.player.botGasUsd = GAS_USD; c.player.defaultMinutes = ROUND_MINUTES;
  const pvp = SIM_DIFFS.pvp;
  const D: SimDifficulty = { ...JSON.parse(JSON.stringify(pvp)), label: `PAPER · ${PAPER_LABEL[d]}`, tag: "PAPER TRADING", color: PAPER_COLOR[d], blurb: PAPER_BLURB[d],
    initial: {}, arrivalsPerMin: 0, mix: { crew: 1 }, activity: 1, size: 1, maxBots: 201, hypeSigma: 0, startS: [0.5, 2], tradeScale: 1,
    takeProfit: undefined, waves: undefined, rug: undefined };
  D.orders = { ...D.orders, rate: 0 };
  (c.difficulties as Record<string, SimDifficulty>)[paperDiffId(d) as string] = D;
  for (const a of Object.keys(ARCH_LABEL) as PaperArchetype[]) {
    const tier = (Object.keys(TIER_ARCHETYPES) as Tier[]).find((t) => TIER_ARCHETYPES[t].some(([x]) => x === a))!, p = brainFor(tier, a, d);
    const A: SimArchetype = { label: ARCH_LABEL[a], blurb: ARCH_LABEL[a], cash: START_CASH[d], cashSigma: 0, rate: 60 / p.intervalS, buyFrac: [0.1, 0.2], tp: 1, sellFrac: [1, 1], sl: -9,
      dip: 0, chase: 0, resist: 0, followPlayer: 0, style: "compete", names: ["bot"] };
    (c.archetypes as Record<string, SimArchetype>)[paperArchId(a) as string] = A;
  }
  return c;
}

export interface BotMeta { agg: number; tier: Tier; arch: PaperArchetype; rating: number; p: BrainParams; react: number; peak: number; pos0: number; ladderHit: number; entryT: number; lastTradeT: number }
const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

/** The ONE bot brain + lobby spawner (SimBrain). Also keeps the round's public history (mcap per block, VWAP, tax). */
export class PaperBrain implements SimBrain {
  meta = new Map<number, BotMeta>();
  /** mcap after every 100 ms block (index = block) */
  hist: number[] = [];
  phases: { id: string; start: number; mood: number; vol: number }[] = [];
  mood = 0; vol = 1; phaseIdx = -1; phaseLog: { id: string; t: number }[] = [];
  vwapNum = 0; vwapDen = 0;
  totals = { fees: 0, gas: 0, snipeTax: 0, snipeHits: 0, trades: 0, buys: 0, sells: 0 };
  /** every trade of the round (SimRun keeps only the last ~3–4K) */
  log: SimTrade[] = [];
  /** ascension pool bookkeeping: traded volume $ and first-buy time per wallet ("you" = the player) */
  volBy = new Map<string, number>(); firstBuyT = new Map<string, number>();
  /** public top-3 race, refreshed every block; payouts once the coin ASCENDS (empty otherwise) */
  race: { wallet: string; contrib: number; payout: number }[] = []; bonus = new Map<string, number>(); bonusPaid = false;
  get pool() { return ASCENSION_POOL[this.difficulty]; }
  /** adaptive (Elo-style) handicap: bot start stacks × botCashK (sizing still keys off the lobby stack). Set before init. */
  botCashK = BOT_CASH_K_OVERRIDE["_"] ?? 1;
  /** eliteK < 1: the current top-LEADERS_N bots by PnL get careful (skip / bank), the adaptive lever for the #1 spot */
  leaders = new Set<number>();
  /** eliteK > 1 elites: open one early position (ELITE_STAKE × start cash the block the anti-snipe tax ends), then take +15% / stop −30% */
  elite = new Set<number>(); eliteIn = new Set<number>();
  /** extra stack multiple (eliteK > 1) for the ELITE_N highest-aggression bots (the adaptive win-rate lever; botCashK steers top-10) */
  eliteK = 1;
  constructor(public difficulty: PaperDifficulty, public botCount = 200) { this.botCashK = BOT_CASH_K_OVERRIDE[difficulty] ?? this.botCashK; }
  get startCash() { return START_CASH[this.difficulty]; }
  init(run: SimRun) {
    const n = Math.min(200, Math.max(0, this.botCount)), mix = LOBBY_MIX[this.difficulty], tiers: Tier[] = ["easy", "medium", "hard"];
    const counts = tiers.map((t) => Math.round(mix[t] * n / 200)); counts[1] += n - counts.reduce((a, b) => a + b, 0);
    tiers.forEach((tier, ti) => {
      const arch = TIER_ARCHETYPES[tier];
      for (let k = 0; k < counts[ti]; k++) {
        let x = run.rng(), a: PaperArchetype = arch[arch.length - 1][0];
        for (const [aa, w] of arch) { if (x < w) { a = aa; break; } x -= w; }
        const b = run.spawn(paperArchId(a), 0);
        b.cash = b.cash0 = this.startCash * this.botCashK;   // botCashK: adaptive handicap (lib/sim/rating), 1 = equal start; equal start (spawn's lognormal is σ 0, hype 1 — pinned anyway)
        const p = this.jitter(run, brainFor(tier, a, this.difficulty)), [r0, r1] = RATING_BAND[tier];
        b.nextT = p.activeFrom[0] + run.rng() * (p.activeFrom[1] - p.activeFrom[0]);
        const sg = TUNE.aggSigma[this.difficulty] * Math.min(1, this.eliteK), z = Math.sqrt(-2 * Math.log(1 - run.rng())) * Math.cos(2 * Math.PI * run.rng()), agg = sg > 0 ? Math.exp(sg * z - sg * sg / 2) : 1;
        this.meta.set(b.id, { agg, tier, arch: a, rating: Math.round(r0 + run.rng() * (r1 - r0)), p, react: p.reactS[0] + run.rng() * (p.reactS[1] - p.reactS[0]), peak: 0, pos0: 0, ladderHit: 0, entryT: 0, lastTradeT: -1e9 });
      }
    });
    if (this.eliteK > 1) [...run.bots].sort((x, y) => this.meta.get(y.id)!.agg - this.meta.get(x.id)!.agg || x.id - y.id).slice(0, Math.min(ELITE_MAX, Math.round(ELITE_N * this.eliteK))).forEach((b) => this.elite.add(b.id));
    this.phases = PHASES.map((ph, i) => ({ id: ph.id, start: i === 0 ? 0 : ph.start + (run.rng() * 30 - 15), mood: ph.mood[0] + run.rng() * (ph.mood[1] - ph.mood[0]) + TUNE.moodBias[this.difficulty], vol: ph.vol }));
    this.hist.push(run.m.mcap());
    run.on(({ trade }) => { if (trade) this.onTrade(run, trade); });
  }
  private onTrade(run: SimRun, tr: SimTrade) {
    const w = tr.wallet ?? "you";
    this.volBy.set(w, (this.volBy.get(w) ?? 0) + tr.usd);
    if (tr.side === "buy" && !this.firstBuyT.has(w)) this.firstBuyT.set(w, tr.t);
    this.log.push(tr); this.totals.trades++; this.totals[tr.side === "buy" ? "buys" : "sells"]++;
    this.totals.fees += tr.usd * run.m.fee; this.totals.gas += tr.gas ?? 0;
    // sniper tax: buys on the curve inside the 7 s table (the market charged it on this same block)
    const tax = tr.side === "buy" && tr.preMcap < run.cfg.launch.graduationMcapUsd && (run.m.gradAt == null || run.m.gradAt >= tr.t) ? run.m.antiSnipe(tr.t) : 0;
    if (tax > 0) { this.totals.snipeTax += tr.usd * tax; this.totals.snipeHits++; }
    if (tr.side === "buy") { this.vwapNum += tr.usd * (1 - run.m.fee - tax); this.vwapDen += tr.tokens; }
  }
  /** ±12% per numeric parameter, seeded (spec Sec. 6) */
  private jitter(run: SimRun, b: BrainParams): BrainParams {
    const j = (x: number) => x * (1 + (run.rng() * 2 - 1) * 0.12), out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === "number") out[k] = j(v);
      else if (Array.isArray(v) && typeof v[0] === "number") out[k] = (v as number[]).map(j);
      else if (Array.isArray(v)) out[k] = (v as [number, number][]).map(([g, f]) => [j(g), f]);
      else out[k] = v;
    }
    return out as unknown as BrainParams;
  }
  /** a wallet's pool score: cost basis still held (≥ 0) + VOLUME_CREDIT × volume $ */
  scoreOf(wallet: string, costBasis: number) { return Math.max(0, costBasis) + ASCENSION_VOLUME_CREDIT * (this.volBy.get(wallet) ?? 0); }
  /** every wallet that traded, with its pool score (field `contrib`) */
  contributors(run: SimRun): Contributor[] {
    const out: Contributor[] = [], add = (w: string, cb: number) => { if (this.volBy.has(w)) out.push({ wallet: w, contrib: this.scoreOf(w, cb), firstT: this.firstBuyT.get(w) ?? 1e9 }); };
    for (const b of run.bots) add(b.wallet, b.pos.size > 0 ? b.pos.costBasis : 0);
    add("you", run.player.pos.size > 0 ? run.player.pos.costBasis : 0);
    return out;
  }
  onGraduate(run: SimRun) {
    this.race = splitPool(this.contributors(run), this.pool); this.bonusPaid = true;
    for (const x of this.race) { this.bonus.set(x.wallet, x.payout); const a = x.wallet === "you" ? run.player : run.bots.find((b) => b.wallet === x.wallet)!; a.cash += x.payout; }   // USDG cash
  }
  afterBlock(run: SimRun) {
    if (this.elite.size && !this.eliteIn.size && run.m.antiSnipe(run.t) === 0) for (const b of run.bots) if (this.elite.has(b.id)) { this.buy(run, b, Math.min(b.cash * 0.9, this.startCash * ELITE_STAKE)); this.eliteIn.add(b.id); const M = this.meta.get(b.id)!; M.lastTradeT = run.t; M.pos0 = b.pos.size; M.entryT = run.t; M.peak = run.m.price(); }   // elites: in as soon as the launch anti-snipe tax is off
    if (!this.bonusPaid && run.m.phase === "curve") this.race = splitPool(this.contributors(run), this.pool);
    this.hist.push(run.m.mcap());
    if (this.eliteK < 1 && this.hist.length % 10 === 0) { const px = run.m.price(); this.leaders = new Set([...run.bots].sort((x, y) => (y.cash + y.pos.size * px - y.cash0) - (x.cash + x.pos.size * px - x.cash0)).slice(0, LEADERS_N).map((b) => b.id)); }
    let i = 0; for (let k = 0; k < this.phases.length; k++) if (run.t >= this.phases[k].start) i = k;
    if (i !== this.phaseIdx) { this.phaseIdx = i; const ph = this.phases[i]; this.mood = ph.mood; this.vol = ph.vol; this.phaseLog.push({ id: ph.id, t: run.t }); }
  }
  /** mcap as a bot sees it: react s stale, never the future */
  seen(run: SimRun, lag: number, backS = 0) { const B = run.cfg.market.blockS, k = this.hist.length - 1 - Math.round((lag + backS) / B); return this.hist[Math.max(0, k)]; }
  private buy(run: SimRun, b: Bot, usd: number) {
    const gas = run.cfg.player.botGasUsd ?? 0; usd = Math.min(usd, b.cash - gas);
    if (!(usd >= 0.5)) return false;
    return run.botTrade(b, "buy", usd).ok;
  }
  private sell(run: SimRun, b: Bot, tokens: number) {
    tokens = Math.min(tokens, b.pos.size); if (!(tokens > 1e-9) || b.cash < (run.cfg.player.botGasUsd ?? 0)) return false;
    return run.botTrade(b, "sell", tokens).ok;
  }
  decide(run: SimRun, b: Bot) {
    const M = this.meta.get(b.id); if (!M) return;
    const p = M.p, now = this.seen(run, M.react), price = now / run.m.S;
    if (b.pos.size > 0) M.peak = Math.max(M.peak, price);
    if (run.t - M.lastTradeT < p.cooldownS) return;
    const n0 = run.trades.length, had = b.pos.size;
    if (this.eliteIn.has(b.id)) {   // sharps: take +SHARP_TP or stop at −SHARP_SL from their opening entry, then sit out (the profitable bots a passive player has to beat)
      if (b.pos.size > 0) { const g = price / (b.pos.costBasis / Math.max(1e-12, b.pos.size)) - 1; if (g > SHARP_TP || g < -SHARP_SL) this.sell(run, b, b.pos.size); }
      return; }
    if (this.eliteK < 1 && this.leaders.has(b.id) && run.rng() < 1 - this.eliteK) { if (b.pos.size > 0 && run.rng() < 0.15) this.sell(run, b, b.pos.size * 0.3); }   // a leader gets careful: skips, trims
    else this.inner(run, b, M, now, price);
    if (run.trades.length !== n0) { M.lastTradeT = run.t; if (had <= 0 && b.pos.size > 0) { M.pos0 = b.pos.size; M.ladderHit = 0; M.entryT = run.t; M.peak = run.m.price(); } else if (b.pos.size > had && M.ladderHit === 0) M.pos0 = b.pos.size; }
  }
  private inner(run: SimRun, b: Bot, M: BotMeta, now: number, price: number) {
    const p = M.p, r = run.rng, m = run.m, gas = run.cfg.player.botGasUsd ?? 0;
    if (r() < p.noise * NOISE_TRADE_SHARE * this.vol) {
      if (b.pos.size > 0 && r() < 0.4 && !p.neverSell) this.sell(run, b, b.pos.size * (0.25 + r() * 0.75));
      else if (b.cash > 1) this.buy(run, b, this.sizeBuy(run, b, M, 0.3 + r() * 0.7));
      return;
    }
    const nearAsc = p.poolG < 1 && m.phase === "curve" && m.g > p.poolG;
    if (b.pos.size > 0 && !p.neverSell) {
      const value = b.pos.size * price, gain = b.pos.costBasis > 0 ? value * (1 - m.fee) / b.pos.costBasis - 1 : 0;
      const stopHit = p.stop === "panic" || p.stop === "fixed" ? gain < -p.stopPct : p.stop === "trail" ? price < M.peak * (1 - p.stopPct) && gain > -0.5 : false;
      if (stopHit && !(p.stop === "panic" && M.arch === "fomo")) { this.sell(run, b, b.pos.size); return; }
      if (p.firstRed && now < this.seen(run, M.react, 0.5) * 0.997) { this.sell(run, b, b.pos.size); return; }
      if (nearAsc && p.poolHold) return;   // holding for the ascension pool: no profit-taking (stops above still fire)
      if (M.ladderHit < p.ladder.length && gain > p.ladder[M.ladderHit][0]) {
        const frac = p.ladder[M.ladderHit][1]; M.ladderHit++;
        this.sell(run, b, frac >= 0.999 ? b.pos.size : Math.min(b.pos.size, M.pos0 * frac)); return;
      }
      if (p.maxHoldS > 0 && run.t - M.entryT > p.maxHoldS) { this.sell(run, b, b.pos.size); return; }
      if (p.scaleOutNearGrad && m.phase === "curve" && m.g > 0.8 && now < this.seen(run, M.react, 3) && r() < 0.5) { this.sell(run, b, b.pos.size / 3); return; }
    }
    let s = this.score(run, M, now);
    if (nearAsc && p.wPool > 0) {   // the public top-3 race: in it, or one buy away
      const mine = this.scoreOf(b.wallet, b.pos.size > 0 ? b.pos.costBasis : 0), third = this.race.length >= ASCENSION_TOP ? this.race[ASCENSION_TOP - 1].contrib : 0;
      if (mine + (1 + ASCENSION_VOLUME_CREDIT) * this.sizeBuy(run, b, M, 1) >= third) s += p.wPool * clamp((m.g - p.poolG) / (1 - p.poolG), 0, 1);
    }
    if (s > p.buyTh && b.cash > p.minTradeUsd + gas) {
      if (p.curveAware >= 1 && run.t < run.cfg.launch.antiSnipeDurationS + 1) return;   // knows the sniper tax
      if (p.curveAware >= 2 && m.phase === "curve" && m.g > 0.9) return;                 // no fresh entries at the top
      const usd = this.sizeBuy(run, b, M, Math.min(1, (s - p.buyTh) / (1 - p.buyTh) + 0.3));
      if (usd >= Math.max(1, p.minTradeUsd)) this.buy(run, b, usd);
    } else if (s < p.sellTh && b.pos.size > 0 && !p.neverSell) this.sell(run, b, p.curveAware >= 2 ? b.pos.size / 2 : b.pos.size);
  }
  private score(run: SimRun, M: BotMeta, now: number) {
    const p = M.p; let mom = 0;
    for (const w of p.windows) mom += clamp((now / this.seen(run, M.react, w) - 1) / 0.05);
    mom /= p.windows.length;
    let rev = 0;
    if (p.vwap && this.vwapDen > 0) { const vw = this.vwapNum / this.vwapDen * run.m.S; rev = clamp((vw / now - 1) / Math.max(0.02, p.dipPct * 2)); }
    else if (p.dipPct > 0) { let hi = now; for (let k = 1; k <= 30; k += 2) hi = Math.max(hi, this.seen(run, M.react, k)); rev = now < hi * (1 - p.dipPct) ? 1 : 0; }
    const g = run.m.phase === "curve" ? run.m.g : 1, flow = clamp((now / this.seen(run, M.react, 10) - 1) / 0.05);
    const curve = p.curveAware === 1 ? clamp(0.5 - g) : p.curveAware === 2 ? (g < 0.85 ? 0.6 * flow : -0.6) : 0;
    const jitter = (run.rng() * 2 - 1) * 0.15 * this.vol;
    return p.wMom * mom + p.wRev * rev + p.wCurve * curve + p.wMood * this.mood + jitter;
  }
  private sizeBuy(run: SimRun, b: Bot, M: BotMeta, conviction: number) {
    const p = M.p, price = run.m.price(), gas = run.cfg.player.botGasUsd ?? 0, sc = b.cash0 || this.startCash;   // sizes scale with the bot's own stack (adaptive bankroll ⇒ PnL scale)
    const near = p.poolPosK !== 1 && run.m.phase === "curve" && run.m.g > p.poolG;
    const room = Math.max(0, p.maxPos * (near ? p.poolPosK : 1) * p.maxEntries * sc - b.pos.size * price);
    let usd = Math.min(b.cash - gas, room, sc * SIZE_SCALE[this.difficulty] * M.agg * (p.size[0] + (p.size[1] - p.size[0]) * conviction));
    const mi = TUNE.maxImpact[M.tier];
    if (mi > 0 && usd > 0 && run.m.impact(usd, "buy") > 1 + mi) { let lo = 0, hi = usd; for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (run.m.impact(mid, "buy") <= 1 + mi) lo = mid; else hi = mid; } usd = lo; }
    if (p.roundAmounts) { const lim = b.cash - gas, presets = [10, 25, 50, 100].filter((x) => x <= lim); usd = presets.length ? presets.reduce((a, x) => (Math.abs(x - usd) < Math.abs(a - usd) ? x : a)) : 0; }
    return Math.max(0, usd);
  }
}

/** a new paper lobby's SimRun pieces (the caller builds SimRun / SimDriver with them) */
export function paperLobby(d: PaperDifficulty, botCount = 200) { return { cfg: paperConfig(d), difficulty: paperDiffId(d), brain: new PaperBrain(d, botCount), minutes: ROUND_MINUTES, endOnGraduate: true as const }; }

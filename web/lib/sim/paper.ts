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
export const SIZE_SCALE: Record<PaperDifficulty, number> = { easy: 0.7, medium: 0.237, hard: 0.15 }; // v1: 1 / 0.13 / 0.11; v2: 0.87 / 0.15 / 0.15 (Easy at $100 stacks)
export const NOISE_TRADE_SHARE = 0.25;

/** One brain, parameterised (spec Sec. 5) */
export interface BrainParams {
  reactS: [number, number]; intervalS: number; noise: number; windows: number[]; vwap: boolean;
  wMom: number; wRev: number; wCurve: number; wMood: number; buyTh: number; sellTh: number;
  stop: "none" | "panic" | "fixed" | "trail"; stopPct: number; ladder: [number, number][]; scaleOutNearGrad: boolean; dipPct: number;
  size: [number, number]; maxPos: number; maxEntries: number; roundAmounts: boolean; minTradeUsd: number; curveAware: 0 | 1 | 2;
  maxHoldS: number; firstRed: boolean; neverSell: boolean; cooldownS: number; activeFrom: [number, number];
}
const TIER_BASE: Record<Tier, BrainParams> = {
  easy: { reactS: [2, 3], intervalS: 2, noise: 0.27, windows: [2], vwap: false, wMom: 1, wRev: 0, wCurve: 0, wMood: 0.5, buyTh: 0.25, sellTh: -0.6,
    stop: "panic", stopPct: 0.35, ladder: [[0.15, 1]], scaleOutNearGrad: false, dipPct: 0, size: [0.2, 0.5], maxPos: 0.8, maxEntries: 1, roundAmounts: true,
    minTradeUsd: 0, curveAware: 0, maxHoldS: 0, firstRed: false, neverSell: false, cooldownS: 3, activeFrom: [0, 420] },
  medium: { reactS: [0.8, 1.2], intervalS: 1, noise: 0.1, windows: [5, 30], vwap: false, wMom: 0.8, wRev: 0.3, wCurve: 0.2, wMood: 0.4, buyTh: 0.3, sellTh: -0.35,
    stop: "fixed", stopPct: 0.12, ladder: [[0.25, 1 / 3], [0.5, 1 / 3]], scaleOutNearGrad: false, dipPct: 0.1, size: [0.1, 0.25], maxPos: 0.5, maxEntries: 1.4,
    roundAmounts: false, minTradeUsd: 5, curveAware: 1, maxHoldS: 0, firstRed: false, neverSell: false, cooldownS: 4, activeFrom: [8, 300] },
  hard: { reactS: [0.15, 0.25], intervalS: 0.5, noise: 0.025, windows: [3, 20, 60], vwap: true, wMom: 0.7, wRev: 0.6, wCurve: 0.5, wMood: 0.3, buyTh: 0.35, sellTh: -0.3,
    stop: "trail", stopPct: 0.08, ladder: [[0.2, 0.25], [0.4, 0.25], [0.7, 0.25]], scaleOutNearGrad: true, dipPct: 0.03, size: [0.3, 0.5], maxPos: 0.35, maxEntries: 2.6,
    roundAmounts: false, minTradeUsd: 12, curveAware: 2, maxHoldS: 0, firstRed: false, neverSell: false, cooldownS: 5, activeFrom: [8, 240] },
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
  // v2.2 (Oct 31): Medium-lobby only — pickier, slower bots with wider stops and bigger, lumpier bets, cooler mood; pulls the
  // strong player's Medium win rate from ~42% to ~16%. Hard lobby left at v2 (no bot-knob config beat it out of sample).
  lobby: { medium: { easy: { buyTh: 0.505, cooldownS: 9.12, stopPct: 0.168, maxPos: 0.688 }, medium: { buyTh: 0.373, cooldownS: 6.69, stopPct: 0.317, maxPos: 0.552 },
    hard: { buyTh: 0.493, cooldownS: 5.9, stopPct: 0.221, maxPos: 0.766 } } },
  aggSigma: { easy: 0.68, medium: 1.453, hard: 1.2 }, moodBias: { easy: -0.04, medium: -0.192, hard: 0.12 }, maxImpact: { easy: 0, medium: 0, hard: 0 },
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
  constructor(public difficulty: PaperDifficulty, public botCount = 200) {}
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
        b.cash = b.cash0 = this.startCash;   // equal start (spawn's lognormal is σ 0, hype 1 — pinned anyway)
        const p = this.jitter(run, brainFor(tier, a, this.difficulty)), [r0, r1] = RATING_BAND[tier];
        b.nextT = p.activeFrom[0] + run.rng() * (p.activeFrom[1] - p.activeFrom[0]);
        const sg = TUNE.aggSigma[this.difficulty], z = Math.sqrt(-2 * Math.log(1 - run.rng())) * Math.cos(2 * Math.PI * run.rng()), agg = sg > 0 ? Math.exp(sg * z - sg * sg / 2) : 1;
        this.meta.set(b.id, { agg, tier, arch: a, rating: Math.round(r0 + run.rng() * (r1 - r0)), p, react: p.reactS[0] + run.rng() * (p.reactS[1] - p.reactS[0]), peak: 0, pos0: 0, ladderHit: 0, entryT: 0, lastTradeT: -1e9 });
      }
    });
    this.phases = PHASES.map((ph, i) => ({ id: ph.id, start: i === 0 ? 0 : ph.start + (run.rng() * 30 - 15), mood: ph.mood[0] + run.rng() * (ph.mood[1] - ph.mood[0]) + TUNE.moodBias[this.difficulty], vol: ph.vol }));
    this.hist.push(run.m.mcap());
    run.on(({ trade }) => { if (trade) this.onTrade(run, trade); });
  }
  private onTrade(run: SimRun, tr: SimTrade) {
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
  afterBlock(run: SimRun) {
    this.hist.push(run.m.mcap());
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
    this.inner(run, b, M, now, price);
    if (run.trades.length !== n0) { M.lastTradeT = run.t; if (had <= 0 && b.pos.size > 0) { M.pos0 = b.pos.size; M.ladderHit = 0; M.entryT = run.t; M.peak = run.m.price(); } else if (b.pos.size > had && M.ladderHit === 0) M.pos0 = b.pos.size; }
  }
  private inner(run: SimRun, b: Bot, M: BotMeta, now: number, price: number) {
    const p = M.p, r = run.rng, m = run.m, gas = run.cfg.player.botGasUsd ?? 0;
    if (r() < p.noise * NOISE_TRADE_SHARE * this.vol) {
      if (b.pos.size > 0 && r() < 0.4 && !p.neverSell) this.sell(run, b, b.pos.size * (0.25 + r() * 0.75));
      else if (b.cash > 1) this.buy(run, b, this.sizeBuy(run, b, M, 0.3 + r() * 0.7));
      return;
    }
    if (b.pos.size > 0 && !p.neverSell) {
      const value = b.pos.size * price, gain = b.pos.costBasis > 0 ? value * (1 - m.fee) / b.pos.costBasis - 1 : 0;
      const stopHit = p.stop === "panic" || p.stop === "fixed" ? gain < -p.stopPct : p.stop === "trail" ? price < M.peak * (1 - p.stopPct) && gain > -0.5 : false;
      if (stopHit && !(p.stop === "panic" && M.arch === "fomo")) { this.sell(run, b, b.pos.size); return; }
      if (p.firstRed && now < this.seen(run, M.react, 0.5) * 0.997) { this.sell(run, b, b.pos.size); return; }
      if (M.ladderHit < p.ladder.length && gain > p.ladder[M.ladderHit][0]) {
        const frac = p.ladder[M.ladderHit][1]; M.ladderHit++;
        this.sell(run, b, frac >= 0.999 ? b.pos.size : Math.min(b.pos.size, M.pos0 * frac)); return;
      }
      if (p.maxHoldS > 0 && run.t - M.entryT > p.maxHoldS) { this.sell(run, b, b.pos.size); return; }
      if (p.scaleOutNearGrad && m.phase === "curve" && m.g > 0.8 && now < this.seen(run, M.react, 3) && r() < 0.5) { this.sell(run, b, b.pos.size / 3); return; }
    }
    const s = this.score(run, M, now);
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
    const p = M.p, price = run.m.price(), gas = run.cfg.player.botGasUsd ?? 0, sc = this.startCash;
    const room = Math.max(0, p.maxPos * p.maxEntries * sc - b.pos.size * price);
    let usd = Math.min(b.cash - gas, room, sc * SIZE_SCALE[this.difficulty] * M.agg * (p.size[0] + (p.size[1] - p.size[0]) * conviction));
    const mi = TUNE.maxImpact[M.tier];
    if (mi > 0 && usd > 0 && run.m.impact(usd, "buy") > 1 + mi) { let lo = 0, hi = usd; for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (run.m.impact(mid, "buy") <= 1 + mi) lo = mid; else hi = mid; } usd = lo; }
    if (p.roundAmounts) { const lim = b.cash - gas, presets = [10, 25, 50, 100].filter((x) => x <= lim); usd = presets.length ? presets.reduce((a, x) => (Math.abs(x - usd) < Math.abs(a - usd) ? x : a)) : 0; }
    return Math.max(0, usd);
  }
}

/** a new paper lobby's SimRun pieces (the caller builds SimRun / SimDriver with them) */
export function paperLobby(d: PaperDifficulty, botCount = 200) { return { cfg: paperConfig(d), difficulty: paperDiffId(d), brain: new PaperBrain(d, botCount), minutes: ROUND_MINUTES }; }

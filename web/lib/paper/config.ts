/**
 * PAPER TRADING (1 player vs 200 bots) — match config + the ONE bot brain's parameter table (spec v0.2 Sec. 2, 5, 6).
 * Everything here is data: a balance change is a config diff, not a code change (spec Sec. 5 implementation note).
 * Market constants are NOT re-typed here: the curve, fee, sniper tax and pool come from lib/sim/config LAUNCH
 * (= lib/config CURVE + lib/curveMath, mirrors contracts/src/libraries/Constants.sol), caps from lib/modeRules.
 * Values marked TUNE are the spec's starting points.
 */
import { MODE, type ModeId } from "../modeRules";

export type Difficulty = "easy" | "medium" | "hard";
export type Tier = "easy" | "medium" | "hard";
export type Archetype = "fomo" | "paperhands" | "diamond" | "scalper" | "swinger" | "sniper" | "exit" | "dip";

export const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

/** Lobby record config (spec Sec. 2 / Sec. 9 Lobby.config). */
export interface MatchConfig {
  difficulty: Difficulty;
  startCash: number;
  durationSec: number;
  /** sample gas, $ flat per trade, out of cash, never into the curve (SAMPLE - TUNE) */
  gasFeeFlat: number;
  botCount: number;
  tickMs: number;
  /** player intents per second (spec Sec. 3: max 5/s, TUNE) */
  maxIntentsPerSec: number;
  /** coin's launch mode — sets the holding cap + crew tip. ASSUMPTION: Easy (the live default launch mode). */
  coinMode: ModeId;
  /** Launchpad.crewTipThresholdBps default (Constants.CREW_TIP_THRESHOLD_BPS_DEFAULT) */
  crewTipThresholdBps: number;
}

export const START_CASH: Record<Difficulty, number> = { easy: 100, medium: 500, hard: 1000 };
/** spec Sec. 6 lobby mix (Easy / Medium / Hard bots) for 200 bots; scaled proportionally for other bot counts */
export const LOBBY_MIX: Record<Difficulty, Record<Tier, number>> = {
  easy: { easy: 140, medium: 50, hard: 10 },
  medium: { easy: 60, medium: 100, hard: 40 },
  hard: { easy: 20, medium: 60, hard: 120 },
};
/** archetypes inside each tier (spec Sec. 6) with their share of the tier (ASSUMPTION: equal-ish split) */
export const TIER_ARCHETYPES: Record<Tier, [Archetype, number][]> = {
  easy: [["fomo", 0.4], ["paperhands", 0.35], ["diamond", 0.25]],
  medium: [["scalper", 0.5], ["swinger", 0.5]],
  hard: [["sniper", 0.34], ["exit", 0.33], ["dip", 0.33]],
};
export const RATING_BAND: Record<Tier, [number, number]> = { easy: [800, 1200], medium: [1300, 1700], hard: [1900, 2400] };

/** Bot sizing scale per lobby (TUNE, ASSUMPTION): richer lobbies would graduate in ~2 min if every bot sized off its
 *  full stack (~$6.5K net buy pressure vs $100K-$200K gross). Bots size buys as size × sizeScale × startCash; the
 *  player is not scaled. Symmetric: it changes how bots bet, not what they may do. */
export const SIZE_SCALE: Record<Difficulty, number> = { easy: 1, medium: 0.13, hard: 0.11 };
/** fraction of a decision that is replaced by a random trade = noise × NOISE_TRADE_SHARE (noise is "share of trades") */
export const NOISE_TRADE_SHARE = 0.25;

export function matchConfig(difficulty: Difficulty, over: Partial<MatchConfig> = {}): MatchConfig {
  return {
    difficulty, startCash: START_CASH[difficulty], durationSec: 600, gasFeeFlat: 0.25, botCount: 200, tickMs: 250,
    maxIntentsPerSec: 5, coinMode: MODE.EASY, crewTipThresholdBps: 50, ...over,
  };
}

/** One brain, parameterised (spec Sec. 5). Ranges [lo, hi] are drawn per bot; all numbers are jittered ±12% per bot. */
export interface BrainParams {
  reactMs: [number, number];
  intervalS: number;
  /** probability a decision is replaced by a random trade */
  noise: number;
  /** lookback windows in seconds (momentum); vwap = also reads the table's VWAP */
  windows: number[]; vwap: boolean;
  /** score weights: momentum, mean reversion vs VWAP / recent high, curve position, backdrop mood */
  wMom: number; wRev: number; wCurve: number; wMood: number;
  buyTh: number; sellTh: number;
  /** stop: none | panic (Easy -35%) | fixed | trail (from peak) */
  stop: "none" | "panic" | "fixed" | "trail"; stopPct: number;
  /** take-profit ladder: [gain, fraction of the ORIGINAL position] */
  ladder: [number, number][];
  /** scale out as the curve nears graduation (Hard) */
  scaleOutNearGrad: boolean;
  /** dip rule: buy when price is this far below the recent high (Medium) / VWAP (Hard); 0 = none */
  dipPct: number;
  /** buy size as a fraction of cash [lo, hi] (scaled by conviction) */
  size: [number, number];
  /** max position value per entry as a fraction of starting cash; total exposure = maxPos × maxEntries (scaled entries) */
  maxPos: number; maxEntries: number;
  /** round buy sizes to the UI presets ($10/25/50/100) — Easy's "round amounts" tell */
  roundAmounts: boolean;
  /** minimum trade $ — gas awareness (Hard), 0 = ignores gas */
  minTradeUsd: number;
  /** 0 none, 1 % sold, 2 full (% sold, distance to graduation, flow, sniper tax) */
  curveAware: 0 | 1 | 2;
  maxHoldS: number;
  /** sells on the first red tick, re-buys on green (Paper Hands) */
  firstRed: boolean;
  neverSell: boolean;
  /** min seconds between this bot's own trades (gas discipline; Easy 0 = over-trades) */
  cooldownS: number;
  /** when the bot becomes active: [lo, hi] seconds into the match (staggered deployment) */
  activeFrom: [number, number];
}

const TIER_BASE: Record<Tier, BrainParams> = {
  easy: {
    reactMs: [2000, 3000], intervalS: 2, noise: 0.27, windows: [2], vwap: false,
    wMom: 1, wRev: 0, wCurve: 0, wMood: 0.5, buyTh: 0.25, sellTh: -0.6,
    stop: "panic", stopPct: 0.35, ladder: [[0.15, 1]], scaleOutNearGrad: false, dipPct: 0,
    size: [0.2, 0.5], maxPos: 0.8, maxEntries: 1, roundAmounts: true, minTradeUsd: 0, curveAware: 0, maxHoldS: 0,
    firstRed: false, neverSell: false, cooldownS: 3, activeFrom: [0, 420],
  },
  medium: {
    reactMs: [800, 1200], intervalS: 1, noise: 0.1, windows: [5, 30], vwap: false,
    wMom: 0.8, wRev: 0.3, wCurve: 0.2, wMood: 0.4, buyTh: 0.3, sellTh: -0.35,
    stop: "fixed", stopPct: 0.12, ladder: [[0.25, 1 / 3], [0.5, 1 / 3]], scaleOutNearGrad: false, dipPct: 0.1,
    size: [0.1, 0.25], maxPos: 0.5, maxEntries: 1.4, roundAmounts: false, minTradeUsd: 5, curveAware: 1, maxHoldS: 0,
    firstRed: false, neverSell: false, cooldownS: 4, activeFrom: [8, 300],
  },
  hard: {
    reactMs: [150, 250], intervalS: 0.5, noise: 0.025, windows: [3, 20, 60], vwap: true,
    wMom: 0.7, wRev: 0.6, wCurve: 0.5, wMood: 0.3, buyTh: 0.35, sellTh: -0.3,
    stop: "trail", stopPct: 0.08, ladder: [[0.2, 0.25], [0.4, 0.25], [0.7, 0.25]], scaleOutNearGrad: true, dipPct: 0.03,
    size: [0.3, 0.5], maxPos: 0.35, maxEntries: 2.6, roundAmounts: false, minTradeUsd: 12, curveAware: 2, maxHoldS: 0,
    firstRed: false, neverSell: false, cooldownS: 5, activeFrom: [8, 240],
  },
};

/** archetype overrides on top of the tier base (spec Sec. 6 "tell the player can learn") */
const ARCH_OVERRIDE: Record<Archetype, Partial<BrainParams>> = {
  fomo: { wMom: 1.4, buyTh: 0.35, activeFrom: [0, 360] },                       // buys after big green, late, round $
  paperhands: { firstRed: true, ladder: [[0.1, 1]] },                            // sells first red, re-buys higher
  diamond: { neverSell: true, wMom: 0.8, buyTh: 0.2, size: [0.3, 0.6] },         // never sells
  scalper: { size: [0.04, 0.1], ladder: [[0.06, 0.5], [0.12, 0.5]], stopPct: 0.06, maxHoldS: 45, buyTh: 0.2 },
  swinger: { size: [0.2, 0.35], intervalS: 1.5, buyTh: 0.4, ladder: [[0.25, 1 / 3], [0.5, 1 / 3]] },
  sniper: { wMom: 1.1, wRev: 0.2, buyTh: 0.4, size: [0.45, 0.7], activeFrom: [8, 60] },   // early in a move, conviction
  exit: { ladder: [[0.12, 0.25], [0.25, 0.25], [0.4, 0.25], [0.6, 0.25]], wCurve: 0.9 },  // scales out before tops
  dip: { wMom: 0.2, wRev: 1.2, dipPct: 0.05, size: [0.25, 0.35] },                         // buys drawdowns in tranches
};

export function brainFor(tier: Tier, arch: Archetype): BrainParams {
  return { ...TIER_BASE[tier], ...ARCH_OVERRIDE[arch] };
}

export const ARCH_LABEL: Record<Archetype, string> = {
  fomo: "FOMO Chaser", paperhands: "Paper Hands", diamond: "Diamond Bagholder", scalper: "Scalper", swinger: "Swinger",
  sniper: "Sniper", exit: "Exit Artist", dip: "Dip Accumulator",
};

/** Backdrop phases for a 10-min match (spec Sec. 4, TUNE). mood ∈ [-1, 1] biases every wallet's score equally; vol
 *  scales decision noise. Boundaries jitter ±15 s from the seed; trend signs are seeded so "regime is not destiny". */
export const PHASES = [
  { id: "discovery", start: 0, mood: [0.0, 0.25], vol: 1 },
  { id: "first_trend", start: 90, mood: [0.2, 0.55], vol: 1.2 },
  { id: "reversal", start: 240, mood: [-0.6, -0.2], vol: 1.3 },
  { id: "chop_second_trend", start: 330, mood: [-0.2, 0.45], vol: 1.1 },
  { id: "endgame", start: 480, mood: [-0.4, 0.4], vol: 1.6 },
] as const;

/** dedicated bot name pool (never real users / wallets / Top Boosters); every bot also carries a visible BOT marker */
export const NAME_A = ["Paper", "Lunar", "Static", "Velvet", "Copper", "Quiet", "Neon", "Rusty", "Polar", "Amber", "Cobalt", "Dusty", "Echo", "Fuzzy", "Glass", "Hollow", "Ivory", "Jolly", "Kinetic", "Lucky"];
export const NAME_B = ["Otter", "Comet", "Falcon", "Mantis", "Badger", "Pilot", "Rocket", "Heron", "Lynx", "Moth", "Orbit", "Pixel", "Raven", "Squid", "Turtle", "Viper", "Walrus", "Yak", "Zephyr", "Gecko"];

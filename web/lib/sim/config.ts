/**
 * SIMULATOR tuning sandbox — every knob for the local paper market lives here (maker lee).
 * Curve / pool constants and the tier ladder are IMPORTED from lib/config, lib/curveMath and lib/flight/tiers
 * (which mirror contracts/src/libraries/Constants.sol + CurveMath.sol; the contracts stay authoritative). Everything else (bots, difficulties, points, achievements) is
 * sim-only and can be edited live from the ?tune=1 panel; the panel edits a deep copy of SIM_CONFIG.
 */

import { CURVE } from "../config";
import { TRADE_FEE_BPS } from "../curveMath";
import { FLIGHT_TIERS } from "../flight/tiers";
import { KEEPER_TIP_BPS } from "./pool";

// ── Launch params: imported, never re-typed. lib/config CURVE + lib/curveMath mirror contracts/src/libraries/
// Constants.sol; `npm run test:sim-parity` fails if Constants.sol, lib/config, curveMath or this block drift apart.
export interface LaunchParams {
  totalSupply: number; curveSoldBps: number; startMcapUsd: number; graduationMcapUsd: number; tradeFeeBps: number; creatorTaxBps: number;
  /** 0 = no wallet cap (live Launchpad default, Constants.WALLET_CAP_BPS_DEFAULT) */
  walletCapBps: number; antiSnipeStartBps: number; antiSnipeDurationS: number; quotePriceUsd: number;
  /** post-grad pool: the same 1% DISCIPLE fee (hook) */
  poolFeeBps: number;
  /** TrampWallManager.keeperTipBps (0.1%): paid to whoever pulls a filled tramp/wall */
  keeperTipBps: number;
}
export const LAUNCH: LaunchParams = {
  totalSupply: CURVE.totalSupply,                         // TOTAL_SUPPLY
  curveSoldBps: Math.round(CURVE.soldPctAtGrad * 100),    // CURVE_SOLD_BPS — sold on the curve before graduation
  startMcapUsd: CURVE.startMcap,                          // START_MCAP_USD
  graduationMcapUsd: CURVE.graduationMcap,                // GRADUATION_MCAP_USD (Outer Space)
  tradeFeeBps: Number(TRADE_FEE_BPS),                     // TRADE_FEE_BPS (1%)
  creatorTaxBps: 0,                                       // CREATOR_TAX_DEFAULT_BPS
  walletCapBps: CURVE.walletCapDefaultBps,                // WALLET_CAP_BPS_DEFAULT (0 = no cap)
  antiSnipeStartBps: Math.round(CURVE.antiSnipeStartPct * 100),   // ANTI_SNIPE_START_BPS: 77.7% at t=0 …
  antiSnipeDurationS: CURVE.antiSnipeWindowSec,           // … linearly to 0 over ANTI_SNIPE_DURATION (buys only)
  quotePriceUsd: 1,                                       // quote = USD stable in the sim
  poolFeeBps: Number(TRADE_FEE_BPS),
  keeperTipBps: KEEPER_TIP_BPS,
};

// Tier ladder: the flight ladder itself (lib/flight/tiers.ts = engine.js generated copy = Constants.sol TIER_*).
export const TIERS: { name: string; lo: number }[] = FLIGHT_TIERS.map((t) => ({ name: t.name, lo: t.lo }));
export const tierOf = (mcap: number) => { let i = 0; for (let k = 0; k < TIERS.length; k++) if (mcap >= TIERS[k].lo) i = k; return i; };

// ── Bot archetypes ──────────────────────────────────────────────────────────────────────────────────
export type ArchetypeId = "crew" | "scalper" | "whale" | "sniper" | "bundler" | "rugger" | "cto" | "momentum" | "paperhand" | "diamond";
export interface Archetype {
  label: string;
  blurb: string;
  /** starting cash, USD: lognormal median and log-σ */
  cash: number; cashSigma: number;
  /** decisions per simulated minute while active */
  rate: number;
  /** buy size as a fraction of current cash [min, max] */
  buyFrac: [number, number];
  /** take profit at this uPnL fraction (0.5 = +50%); sells sellFrac of the bag */
  tp: number; sellFrac: [number, number];
  /** stop loss at this uPnL fraction (negative); -9 = never */
  sl: number;
  /** weights: buy dips near support / chase momentum / sell into resistance / chase the player's big buys */
  dip: number; chase: number; resist: number; followPlayer: number;
  /** how it plays against you: support = crew-minded dip buyer, compete = maximises its own PnL off your flow,
   *  insider = launch wallets with their own script (sniper / bundle / dev) */
  style: "support" | "compete" | "insider";
  names: string[];
}
export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  crew:      { label: "Crew", blurb: "crewmate: buys dips at support, trims a little at resistance", cash: 600, cashSigma: 0.6, rate: 2.2, buyFrac: [0.08, 0.2], tp: 0.6, sellFrac: [0.08, 0.18], sl: -9, dip: 1, chase: 0.2, resist: 0.5, followPlayer: 0.8, style: "support", names: ["Mira", "Juno", "Oz", "Pax", "Wren", "Ivo", "Lux", "Tam", "Rho", "Sol", "Kit", "Ada"] },
  scalper:   { label: "Scalper", blurb: "in on a tick up, out at +12% or −7%", cash: 450, cashSigma: 0.5, rate: 5, buyFrac: [0.3, 0.6], tp: 0.12, sellFrac: [1, 1], sl: -0.07, dip: 0.1, chase: 1, resist: 0.6, followPlayer: 0.6, style: "compete", names: ["Flip", "Tick", "Snap", "Quik", "Zap", "Blink"] },
  whale:     { label: "Whale", blurb: "rare, huge buys; dumps half at 2×", cash: 9000, cashSigma: 0.7, rate: 0.7, buyFrac: [0.1, 0.3], tp: 1.0, sellFrac: [0.35, 0.6], sl: -0.5, dip: 0.6, chase: 0.6, resist: 0.4, followPlayer: 0.3, style: "compete", names: ["Leviathan", "Moby", "Orca", "Kraken"] },
  sniper:    { label: "Sniper", blurb: "buys the launch block, dumps at 2–4×", cash: 1500, cashSigma: 0.5, rate: 3, buyFrac: [0.6, 0.9], tp: 2.0, sellFrac: [0.6, 1], sl: -0.4, dip: 0, chase: 0.2, resist: 0.3, followPlayer: 0, style: "insider", names: ["Scope", "Deadeye", "Ghost", "Viper", "Hawk", "Tracer"] },
  bundler:   { label: "Bundler", blurb: "clustered wallets holding bundled supply; drip-sells, joins the rug", cash: 800, cashSigma: 0.3, rate: 1.5, buyFrac: [0.9, 1], tp: 1.5, sellFrac: [0.08, 0.2], sl: -9, dip: 0, chase: 0, resist: 0.2, followPlayer: 0, style: "insider", names: ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"] },
  rugger:    { label: "Dev (rugger)", blurb: "dev wallet; pulls the rug when the chart looks juicy", cash: 2600, cashSigma: 0.2, rate: 1, buyFrac: [0.9, 1], tp: 99, sellFrac: [1, 1], sl: -9, dip: 0, chase: 0, resist: 0, followPlayer: 0, style: "insider", names: ["dev"] },
  cto:       { label: "CTO", blurb: "community takeover: revives a rugged chart", cash: 7000, cashSigma: 0.3, rate: 4, buyFrac: [0.05, 0.12], tp: 3, sellFrac: [0.1, 0.2], sl: -9, dip: 1, chase: 0, resist: 0.1, followPlayer: 0.5, style: "support", names: ["CTO Council"] },
  momentum:  { label: "Momentum", blurb: "chases green candles, bails on red", cash: 700, cashSigma: 0.6, rate: 3, buyFrac: [0.2, 0.45], tp: 0.5, sellFrac: [0.5, 1], sl: -0.12, dip: 0, chase: 1.4, resist: 0.3, followPlayer: 1.2, style: "compete", names: ["Rocket", "Chad", "Degen", "Pump", "FOMO", "Ape", "Send"] },
  paperhand: { label: "Paper hand", blurb: "buys hype, panics at −6%, sells at +15%", cash: 160, cashSigma: 0.6, rate: 2.5, buyFrac: [0.4, 0.8], tp: 0.15, sellFrac: [1, 1], sl: -0.06, dip: 0.2, chase: 0.8, resist: 0.4, followPlayer: 0.8, style: "compete", names: ["Shaky", "Jitter", "Panic", "Wobble", "Flinch"] },
  diamond:   { label: "Diamond hand", blurb: "buys and holds; sells a slice only at 10×", cash: 900, cashSigma: 0.6, rate: 1.2, buyFrac: [0.2, 0.5], tp: 9, sellFrac: [0.2, 0.3], sl: -9, dip: 0.8, chase: 0.3, resist: 0, followPlayer: 0.4, style: "support", names: ["Gem", "Rock", "Iron", "Stone", "Steel"] },
};

// ── Difficulties ────────────────────────────────────────────────────────────────────────────────────
export type DifficultyId = "pve" | "pvp" | "trench";
export interface Difficulty {
  label: string; tag: string; blurb: string; color: string;
  /** bots present at launch */
  initial: Partial<Record<ArchetypeId, number>>;
  /** new bots per simulated minute (scaled by attention: momentum, tiers; crushed after a rug until a CTO) */
  arrivalsPerMin: number;
  /** archetype mix of arrivals (weights) */
  mix: Partial<Record<ArchetypeId, number>>;
  /** global multipliers on bot decision rate and trade size */
  activity: number; size: number;
  /** TRENCH: probability the dev rugs, window (s), mcap multiple of launch that tempts it, CTO odds/delay */
  rug?: { chance: number; earliestS: number; latestS: number; minMcap: number; ctoChance: number; ctoDelayS: [number, number]; ctoArrivalBoost: number };
  maxBots: number;
  /** per-run "hype" (log-σ on arrivals and bot cash): how much attention this launch gets — the source of run-to-run variance */
  hypeSigma: number;
  /** launch bots (non-sniper) make their first decision uniformly inside this window, s (default [0.5, 8]) */
  startS?: [number, number];
  /** multiplier on every bot's buy / sell fraction (more frequent, smaller trades; default 1) */
  tradeScale?: number;
  /** per decision: a holder in profit (> +4%) trims a slice — steady profit-taking red candles (default 0) */
  takeProfit?: number;
  /** pullback waves: every everyS a wave of profit-taking lasts durS; holders sell with sellBoost odds per
   *  decision, buys are scaled by buyCut. Dip buyers then recover it (healthy chart: −10–30%, then higher). */
  waves?: { everyS: [number, number]; durS: [number, number]; sellBoost: number; buyCut: number };
  /** how hard bots play YOU. They read only the public tape (your confirmed trades, your placed tramps/walls),
   *  each with its own reaction delay; nothing about pending trades or your intent. */
  adapt: Adapt;
  /** tramps & walls (post-graduation only, like the contract) */
  orders: OrderPlay;
}
export interface Adapt {
  /** per-bot reaction delay range, s (bots see your trades this late) */
  reactS: [number, number];
  /** pump read: your net buys over the last windowS ≥ pumpFrac of quote depth (dump: ≤ −dumpFrac) */
  windowS: number; pumpFrac: number; dumpFrac: number;
  /** per-decision odds, competitive bots: ride your pump · sell into your buys · pile into your dump */
  ride: number; dumpOn: number; pile: number;
  /** a rider takes profit at +tpRide (or as soon as your pump stops and it is green) */
  tpRide: number;
  /** support bots: buy your dip */
  dipBuy: number;
  /** cap: reaction trades may move at most this fraction of quote depth per minute (all bots together) */
  budgetPerMin: number;
  /** cap: at most this many bots react to one read of you (per ~2 s) */
  maxReactors: number;
}
export interface OrderPlay {
  /** per decision: odds a bot (re)considers tramps/walls */
  rate: number; maxPerBot: number; maxTotal: number;
  /** order size: fraction of the bot's cash (tramp) / bag (wall) */
  sizeFrac: [number, number];
  /** competitive bots vs YOUR orders: undercut your wall / front-run your tramp (place just inside it) */
  undercut: number;
  /** support bots stack a tramp next to yours */
  stack: number;
  /** competitive holders dump into your tramp when the price nears it (your bid = their exit) */
  exitInto: number;
  /** keeper bot pulls a filled order after this delay, s */
  keeperS: [number, number];
}
export const DIFFICULTIES: Record<DifficultyId, Difficulty> = {
  pve: {
    label: "PvE", tag: "CREW", color: "#8ff0c0",
    blurb: "Your crew helps the rocket climb. Bots buy dips at support and take modest profits at resistance. Low volatility, steady growth, an occasional small sell.",
    initial: { crew: 20, diamond: 5, scalper: 4, paperhand: 3 }, arrivalsPerMin: 10, mix: { crew: 0.55, diamond: 0.2, paperhand: 0.13, scalper: 0.12 },
    activity: 5.5, size: 1.9, maxBots: 90, hypeSigma: 0.12,
    startS: [0.3, 1.4], tradeScale: 0.25, takeProfit: 0.055,
    waves: { everyS: [12, 28], durS: [4, 9], sellBoost: 0.42, buyCut: 0.1 },
    adapt: { reactS: [2.5, 4.5], windowS: 20, pumpFrac: 0.03, dumpFrac: 0.02, ride: 0.06, dumpOn: 0.03, pile: 0, tpRide: 0.3, dipBuy: 0.5, budgetPerMin: 0.05, maxReactors: 2 },
    orders: { rate: 0.05, maxPerBot: 1, maxTotal: 10, sizeFrac: [0.05, 0.15], undercut: 0.03, stack: 0.5, exitInto: 0, keeperS: [1.5, 4] },
  },
  pvp: {
    label: "PvP", tag: "DOG EAT DOG", color: "#ffd24a",
    blurb: "Pump-and-dump traders maximise their own PnL: momentum chasers, profit takers and whales. Bigger buys, bigger dumps. A high mcap is still possible.",
    initial: { momentum: 5, scalper: 5, paperhand: 4, whale: 1, crew: 3 }, arrivalsPerMin: 6,
    mix: { momentum: 0.26, scalper: 0.22, paperhand: 0.2, whale: 0.07, diamond: 0.13, crew: 0.12 },
    activity: 2.4, size: 0.8, maxBots: 100, hypeSigma: 0.7,
    startS: [0.3, 1.5], tradeScale: 0.55, takeProfit: 0.06,
    adapt: { reactS: [1.2, 2.4], windowS: 20, pumpFrac: 0.025, dumpFrac: 0.02, ride: 0.35, dumpOn: 0.35, pile: 0.3, tpRide: 0.14, dipBuy: 0.2, budgetPerMin: 0.14, maxReactors: 5 },
    orders: { rate: 0.06, maxPerBot: 1, maxTotal: 14, sizeFrac: [0.08, 0.25], undercut: 0.35, stack: 0.1, exitInto: 0.3, keeperS: [1, 3] },
  },
  trench: {
    label: "TRENCH WARFARE", tag: "MERCENARY", color: "#ff6b7d",
    blurb: "Snipers buy the launch. Bundled supply sits in clustered wallets. The dev may rug and crater the chart, and a CTO might revive it. Huge swings: altitude is possible, but hard.",
    initial: { sniper: 4, bundler: 6, rugger: 1, cto: 1, momentum: 2, scalper: 2, paperhand: 3, whale: 1 }, arrivalsPerMin: 4,
    mix: { momentum: 0.28, scalper: 0.26, paperhand: 0.32, whale: 0.04, diamond: 0.05, crew: 0.05 },
    activity: 2.4, size: 0.55, maxBots: 100, hypeSigma: 0.7,
    startS: [0.3, 1.5], tradeScale: 0.65, takeProfit: 0.05,
    rug: { chance: 0.85, earliestS: 40, latestS: 300, minMcap: 2.2, ctoChance: 0.6, ctoDelayS: [20, 70], ctoArrivalBoost: 2.5 },
    adapt: { reactS: [0.6, 1.4], windowS: 20, pumpFrac: 0.02, dumpFrac: 0.015, ride: 0.55, dumpOn: 0.6, pile: 0.5, tpRide: 0.1, dipBuy: 0.08, budgetPerMin: 0.22, maxReactors: 8 },
    orders: { rate: 0.07, maxPerBot: 2, maxTotal: 18, sizeFrac: [0.1, 0.3], undercut: 0.6, stack: 0, exitInto: 0.55, keeperS: [0.6, 2] },
  },
};

// ── Market reading (what bots "see") ────────────────────────────────────────────────────────────────
export const MARKET = {
  emaFastS: 12, emaSlowS: 75,       // momentum = emaFast / emaSlow − 1
  srWindowS: 120,                    // support / resistance = min / max of the last N s
  nearSR: 0.06,                      // "near" support/resistance = within 6%
  playerBigBuyUsd: 50,               // a player buy ≥ this (or ≥ 2% of quote depth) gets the bots' attention
  playerAttentionS: 25,
  blockS: 0.1,                       // RH ≈ 100 ms blocks
};

// ── Player, points, achievements (sim-only scoring layer) ───────────────────────────────────────────
export const PLAYER = { startBalanceUsd: 1000, gasUsd: 0 /* free mode: no gas */, defaultMinutes: 10 };
export const POINTS = {
  perTier: 100,                      // per tier index reached (peak)
  graduation: 500,
  perPnlUsd: 2,                      // per $ of total PnL (realized + unrealized), floored at 0
  rankBonus: [600, 300, 150],        // finishing #1/#2/#3 vs the bots by PnL
  achievement: 150,                  // per sim achievement
};
export interface SimAchievement { id: string; title: string; sub: string }
export const SIM_ACHIEVEMENTS: SimAchievement[] = [
  { id: "graduate", title: "OUTER SPACE", sub: "the coin graduated to the pool" },
  { id: "angels", title: "WINGS", sub: "peak mcap reached MORNING STARS ($100K)" },
  { id: "million", title: "URANUS", sub: "peak mcap reached $1.2M" },
  { id: "green", title: "IN THE GREEN", sub: "finished with positive PnL" },
  { id: "top3", title: "PODIUM", sub: "top 3 by PnL vs the bots" },
  { id: "survivor", title: "RUG SURVIVOR", sub: "finished green in a run with a rug" },
  { id: "cto", title: "COMMUNITY", sub: "witnessed a CTO revival" },
  { id: "early", title: "EARLY BIRD", sub: "bought within the first 30 s" },
  { id: "filled", title: "LIMIT LEGEND", sub: "one of your tramps/walls filled" },
];

export interface SimConfig { launch: typeof LAUNCH; archetypes: typeof ARCHETYPES; difficulties: typeof DIFFICULTIES; market: typeof MARKET; player: typeof PLAYER; points: typeof POINTS }
export const SIM_CONFIG: SimConfig = { launch: LAUNCH, archetypes: ARCHETYPES, difficulties: DIFFICULTIES, market: MARKET, player: PLAYER, points: POINTS };
export const cloneConfig = (c: SimConfig = SIM_CONFIG): SimConfig => JSON.parse(JSON.stringify(c));
/** Saved tuning (localStorage) on top of the defaults: launch params are parity-locked (always the imported
 *  constants, never a stale saved copy); difficulties merge knob by knob so older saves keep working. */
export function mergeTune(saved: Partial<SimConfig> | null | undefined): SimConfig {
  const c = cloneConfig(); if (!saved || typeof saved !== "object") return c;
  const out: SimConfig = { ...c, ...saved, launch: c.launch } as SimConfig;
  out.difficulties = { ...c.difficulties };
  for (const id of Object.keys(c.difficulties) as DifficultyId[]) { const d = saved.difficulties?.[id]; if (!d) continue; const b = c.difficulties[id];
    out.difficulties[id] = { ...b, ...d, adapt: { ...b.adapt, ...(d.adapt || {}) }, orders: { ...b.orders, ...(d.orders || {}) } }; }
  out.archetypes = { ...c.archetypes }; for (const id of Object.keys(c.archetypes) as ArchetypeId[]) { const a = saved.archetypes?.[id]; if (a) out.archetypes[id] = { ...c.archetypes[id], ...a }; }
  return out;
}
/** Local storage namespaces — SIMULATOR data never shares keys with real/paper profiles. */
export const SIM_STORAGE = { pnlPrefix: "disciple.sim.pnl.", runs: "disciple.sim.runs", tune: "disciple.sim.tune", tw: "disciple.sim.tw", swapPrefix: "disciple.sim.swap." };
/** Per-run reset: drop the previous run's ledger and tramps/walls (sim-only keys; never disciple.tw.v1 / paper keys). */
export function resetSimStorage(st: { length: number; key(i: number): string | null; removeItem(k: string): void }) {
  for (let i = st.length - 1; i >= 0; i--) { const k = st.key(i); if (k && (k.startsWith(SIM_STORAGE.pnlPrefix) || k === SIM_STORAGE.tw)) st.removeItem(k); }
}

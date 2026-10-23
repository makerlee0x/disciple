/** DISCIPLE chain + game config — contracts can wire addresses later. */

export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://explorer.robinhood.com", // TBD
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
} as const;

/** Demo live pool: AI/WETH Uniswap v3 on Robinhood Chain */
export const DEMO_POOL = {
  address: "0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d" as const,
  name: "Artificial Inu",
  ticker: "AI / WETH",
  dex: "Uniswap v3",
  fee: 10000,
  tickSpacing: 200,
};

export const CURVE = {
  startMcap: 7_000,
  graduationMcap: 33_000,
  soldPctAtGrad: 72,
  totalSupply: 7_000_000_000,
  decimals: 18,
  /** wallet cap = Launchpad default Constants.WALLET_CAP_BPS_DEFAULT = 0 (no cap): live, paper and SIMULATOR alike */
  walletCapDefaultBps: 0,
  tradeFeeBps: 100, // 1%
  creatorTaxMaxPct: 7,
  antiSnipeStartPct: 77.7,
  antiSnipeWindowSec: 7,
} as const;

/** 18-tier biblically ascending ladder (constitution LOCKED 2026-10-15) */
export const TIERS = [
  { name: "LAUNCH PAD", lo: 7e3, hi: 12e3, bg: "tier0" },
  { name: "OZONE", lo: 12e3, hi: 18e3, bg: "tier1" },
  { name: "STRATOSPHERE", lo: 18e3, hi: 25e3, bg: "tier2" },
  { name: "KÁRMÁN LINE", lo: 25e3, hi: 33e3, bg: "tier3" },
  { name: "OUTER SPACE", lo: 33e3, hi: 55e3, bg: "tier4" },
  { name: "FIRMAMENT", lo: 55e3, hi: 100e3, bg: "tier5" },
  { name: "MORNING STARS", lo: 100e3, hi: 333e3, bg: "tier6" },
  { name: "HEAVENLY HOST", lo: 333e3, hi: 777e3, bg: "tier7" },
  { name: "THE MOON", lo: 777e3, hi: 1.2e6, bg: "tier8" },
  { name: "URANUS", lo: 1.2e6, hi: 3.3e6, bg: "tier9" },
  { name: "LIMBO", lo: 3.3e6, hi: 7.7e6, bg: "tier10" },
  { name: "GATES OF HEAVEN", lo: 7.7e6, hi: 33e6, bg: "tier11" },
  { name: "THRONE ROOM", lo: 33e6, hi: 77e6, bg: "tier12" },
  { name: "CHERUBIM", lo: 77e6, hi: 120e6, bg: "tier13" },
  { name: "SERAPHIM", lo: 120e6, hi: 777e6, bg: "tier14" },
  { name: "AETHER", lo: 777e6, hi: 1.2e9, bg: "tier15" },
  { name: "EMPYREAN", lo: 1.2e9, hi: 3.3e9, bg: "tier16" },
  { name: "SEVENTH HEAVEN", lo: 3.3e9, hi: 7.77e9, bg: "tier17" },
] as const;

/** BUY presets ($ per shot): 4 slots, default $10 / $25 / $50 / $100, editable (Swap settings / ESC menu, stored in
 *  lib/trade/swapSettings). Mirrors public/flight/engine.js MODES (@presets). Sell sizes are fixed 10/25/50/100%. */
export const MODES = [
  { key: "1", name: "P1", usd: 10 },
  { key: "2", name: "P2", usd: 25 },
  { key: "3", name: "P3", usd: 50 },
  { key: "4", name: "P4", usd: 100 },
] as const;

/** Tramps & walls: off-chain points per $1 of FILLED order size, rounded down. Awarded only when the order is filled
 *  (keeper close after a full cross); cancelled or partly filled orders earn 0. Live, paper/mock and SIMULATOR. */
export const TRAMP_WALL_POINTS_PER_USD = 1;

/** Sell bomb tiers by price impact % (constitution LOCKED) */
export const BOMB_PCT = {
  GRENADE: 2,
  BUNKER: 5,
  CRUISE: 12,
  NUKE: 25,
  ATOM: 50,
} as const;

export const BOMB_TIERS = [
  { k: "puff", name: "PUFF", min: 0 },
  { k: "grenade", name: "GRENADE", min: BOMB_PCT.GRENADE },
  { k: "bunker", name: "BUNKER BUSTER", min: BOMB_PCT.BUNKER },
  { k: "cruise", name: "CRUISE MISSILE", min: BOMB_PCT.CRUISE },
  { k: "nuke", name: "NUKE", min: BOMB_PCT.NUKE },
  { k: "atom", name: "ATOM BOMB", min: BOMB_PCT.ATOM },
] as const;

export const GAS = {
  execGas: 200_000,
  ethUsd: 2372,
  robinhoodGwei: 0.0207,
  maxOverhead: 0.05,
} as const;

export function minShotUsd(
  gwei = GAS.robinhoodGwei,
  ethUsd = GAS.ethUsd,
): number {
  const gasUsd = GAS.execGas * gwei * 1e-9 * ethUsd;
  return gasUsd / GAS.maxOverhead;
}

export function fmtUsd(v: number): string {
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

export function gradProgress(mcap: number | null): number | null {
  if (mcap == null) return null;
  if (mcap >= CURVE.graduationMcap) return 100;
  return Math.max(
    0,
    Math.min(
      100,
      ((mcap - CURVE.startMcap) / (CURVE.graduationMcap - CURVE.startMcap)) *
        100,
    ),
  );
}

export const SETTINGS_KEYS = {
  orbs: "disciple.orbs",
  bombs: "disciple.bombs",
  shake: "disciple.shake",
  sidebarHome: "disciple.sidebar.home",
  sidebarGame: "disciple.sidebar.game",
} as const;

/* ------------------------------------------------------------------ */
/* Default quote pairing                                               */
/* ------------------------------------------------------------------ */

/**
 * STRATEGY ("Strategy Coin") on Robinhood Chain (4663).
 * Source: /workspace/anypair/ds_0x1686…1e18.json (DexScreener snapshot).
 * Every launch pairs with this quote by default; Advanced mode can override.
 */
export const STRATEGY_TOKEN = {
  address: "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18" as const,
  symbol: "STRATEGY",
  name: "Strategy Coin",
  decimals: 18,
} as const;

/** Quote presets with known addresses. The /create pair picker builds its curated list from the
 * active deployment (lib/pairs.ts); unknown-address tokens are NOT listed (use "Paste ERC-20"). */
export const QUOTE_PRESETS = [
  { symbol: "STRATEGY", address: STRATEGY_TOKEN.address as string, note: "default" },
] as const;

/* ------------------------------------------------------------------ */
/* Verification: manual yes/no flag (see lib/verified.ts)              */
/* ------------------------------------------------------------------ */
/* No automatic tiers or metric thresholds: the team verifies rockets by hand. */

/** Per-rocket market stats (display / sorting only; they do NOT drive verification). */
export interface RocketStats {
  volume24hUsd: number;
  ageHours: number;
  holders: number;
  liquidityUsd: number;
  mcapUsd: number;
}

/** Launchpad shows all rockets by default, with a "Verified" (hand-verified only) filter → default "all". */
export const LAUNCHPAD_DEFAULT_FILTER: "all" | "verified" = "all";

/** Next unlock reward per altitude tier index (PvE crew rewards; mock copy). */
export function nextUnlock(mcap: number) {
  const i = TIERS.findIndex((t) => mcap < t.hi);
  const idx = i < 0 ? TIERS.length - 1 : i;
  const t = TIERS[idx];
  const next = TIERS[Math.min(idx + 1, TIERS.length - 1)];
  const pct = Math.max(0, Math.min(100, ((mcap - t.lo) / (t.hi - t.lo)) * 100));
  return { current: t.name, next: next.name, targetUsd: t.hi, pct };
}

/* ------------------------------------------------------------------ */
/* Image moderation (see docs/moderation.md)                           */
/* ------------------------------------------------------------------ */
export const MODERATION = {
  /** nsfwjs class thresholds: block when exceeded. */
  block: { Porn: 0.6, Hentai: 0.6, Sexy: 0.85 },
  /** Grey zone → "review" (held, launch not allowed until a human clears it). */
  review: { Porn: 0.35, Hentai: 0.35, Sexy: 0.6 },
  maxBytes: 2 * 1024 * 1024,
  maxDim: 1024,
  mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  /** Perceptual-hash Hamming distance treated as "same image" for the denylist. */
  phashMaxDistance: 6,
} as const;

export type ModerationVerdict = "allow" | "block" | "review";

/** Shared verdict logic for nsfwjs-style class probabilities. */
export function decideNsfw(scores: Record<string, number>): ModerationVerdict {
  const b = MODERATION.block, r = MODERATION.review;
  const s = (k: string) => scores[k] ?? 0;
  if (s("Porn") > b.Porn || s("Hentai") > b.Hentai || s("Sexy") > b.Sexy) return "block";
  if (s("Porn") > r.Porn || s("Hentai") > r.Hentai || s("Sexy") > r.Sexy) return "review";
  return "allow";
}

/* ------------------------------------------------------------------ */
/* Hold bonus (PROPOSAL — Maker to tune). Off-chain points only.        */
/* ------------------------------------------------------------------ */
export const HOLD_BONUS = {
  /** multiplier = 1 + min(maxBoost, k·log10(1 + uPnL$/pnlScaleUsd)) × holdTimeFactor × sellScale */
  k: 0.5,
  pnlScaleUsd: 10,
  maxBoost: 1.5,
  /** holdTimeFactor ramps linearly 0 → 1 over this many hours of continuous holding. */
  rampHours: 24,
  /** Position below this $ value earns no bonus (anti-dust / anti-farming). */
  minPositionUsd: 25,
  /** Points are snapshotted at random times per day, not continuously. */
  snapshotsPerDay: 6,
} as const;

export function holdBonus(uPnlUsd: number, heldHours: number, sellScale: number, positionUsd: number): number {
  if (positionUsd < HOLD_BONUS.minPositionUsd || uPnlUsd <= 0) return 1;
  const pnlTerm = Math.min(HOLD_BONUS.maxBoost, HOLD_BONUS.k * Math.log10(1 + uPnlUsd / HOLD_BONUS.pnlScaleUsd));
  const time = Math.max(0, Math.min(1, heldHours / HOLD_BONUS.rampHours));
  return 1 + pnlTerm * time * Math.max(0, Math.min(1, sellScale));
}

/* ------------------------------------------------------------------ */
/* Season ranks (profile framed border)                                */
/* ------------------------------------------------------------------ */
export type SeasonRankTier =
  | "UNRANKED"
  | "NOVICE"
  | "ASCENDANT"
  | "BLESSED"
  | "ANOINTED"
  | "GLORIFIED"
  | "DIVINE";

export const SEASON_RANKS: readonly {
  tier: SeasonRankTier;
  label: string;
  minPoints: number;
  border: string;
}[] = [
  { tier: "UNRANKED", label: "Unranked", minPoints: 0, border: "rgba(180,190,220,0.35)" },
  { tier: "NOVICE", label: "Novice", minPoints: 100, border: "rgba(200,210,230,0.55)" },
  { tier: "ASCENDANT", label: "Ascendant", minPoints: 500, border: "rgba(133,176,214,0.8)" },
  { tier: "BLESSED", label: "Blessed", minPoints: 2_000, border: "#67C1BB" },
  { tier: "ANOINTED", label: "Anointed", minPoints: 8_000, border: "#C9A8DC" },
  { tier: "GLORIFIED", label: "Glorified", minPoints: 25_000, border: "#E5875A" },
  { tier: "DIVINE", label: "Divine", minPoints: 80_000, border: "#DA8B9F" },
] as const;

export function seasonRank(points: number) {
  let best = SEASON_RANKS[0];
  for (const r of SEASON_RANKS) if (points >= r.minPoints) best = r;
  const idx = SEASON_RANKS.findIndex((r) => r.tier === best.tier);
  const next = SEASON_RANKS[Math.min(idx + 1, SEASON_RANKS.length - 1)];
  const span = Math.max(1, next.minPoints - best.minPoints);
  const progress = best.tier === next.tier ? 1 : Math.min(1, (points - best.minPoints) / span);
  return { ...best, next, progress, pointsToNext: Math.max(0, next.minPoints - points) };
}

/** Level from rHALO points (XP bar). */
export function levelFromPoints(points: number): { level: number; xpInto: number; xpNeed: number; progress: number } {
  let level = 1;
  let spent = 0;
  for (;;) {
    const need = Math.floor(100 * Math.pow(level, 1.35));
    if (spent + need > points) {
      const xpInto = points - spent;
      return { level, xpInto, xpNeed: need, progress: xpInto / need };
    }
    spent += need;
    level += 1;
    if (level > 500) return { level, xpInto: 0, xpNeed: need, progress: 1 };
  }
}

/* ------------------------------------------------------------------ */
/* Identity thresholds (CT-native playstyle labels)                    */
/* ------------------------------------------------------------------ */
export const IDENTITY_THRESHOLDS = {
  believerHoldHours: 12,
  believerDrawdownHold: 0.35,
  trencherHoldMinutes: 8,
  trencherMinTrades: 40,
  sniperEntrySec: 120,
  sniperBuyFraction: 0.35,
  diamondDrawdown: 0.5,
  paperHandsSellMinutes: 5,
  paperHandsDip: 0.08,
  exitLiqNearHigh: 0.05,
  exitLiqDrawdown: 0.4,
  exitLiqMinEvents: 3,
  whaleSizePercentile: 0.99,
  degenMinRockets: 15,
  degenMinTrades: 60,
  bagHolderUpnlLoss: 0.5,
  bagHolderHoldHours: 24,
  jeetPumpMultiple: 1.5,
  jeetDumpMinutes: 10,
  bomberMinBombs: 8,
  nukerMinNukes: 2,
  crewCaptainGradTop: 2,
  gateKeeperAssists: 3,
  launcherMinLaunches: 1,
  launcherGraduated: 1,
  kingmakerTierIndex: 6,
  kingmakerCount: 2,
  farmerMaxPnl: 50,
  farmerMinPoints: 5_000,
  smartMoneyRoiDecile: 0.9,
  smartMoneyMinTrades: 10,
  roundTripMultiple: 2,
  ruggedMcapFraction: 0.05,
} as const;

/* ------------------------------------------------------------------ */
/* Achievement rarity frames                                           */
/* ------------------------------------------------------------------ */
/**
 * One rarity scale shared by achievements and rocket parts (cosmetics) — deliberately NOT the
 * season-rank names (Blessed/Anointed/Glorified/Divine stay on SEASON_RANKS only).
 * Lowest → highest.
 */
export const RARITY_SCALE = ["COMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC"] as const;
export type Rarity = (typeof RARITY_SCALE)[number];
export type AchievementRarity = Rarity;

/**
 * Legacy rarity keys (pre-rename, borrowed from season ranks) → current keys. Kept so any stored /
 * cached / API payload that still carries the old key (e.g. topBadges[].rarity) resolves cleanly.
 */
export const LEGACY_RARITY_ALIASES: Readonly<Record<string, Rarity>> = {
  BLESSED: "RARE",
  ANOINTED: "EPIC",
  GLORIFIED: "LEGENDARY",
  DIVINE: "MYTHIC",
};

/** Accepts a current or legacy rarity key (any case); unknown values fall back to COMMON. */
export function normalizeRarity(r: string | null | undefined): Rarity {
  const k = String(r ?? "").toUpperCase();
  if ((RARITY_SCALE as readonly string[]).includes(k)) return k as Rarity;
  return LEGACY_RARITY_ALIASES[k] ?? "COMMON";
}

/** 0 (COMMON) … 4 (MYTHIC); legacy keys are normalized first. */
export function rarityRank(r: string): number {
  return RARITY_SCALE.indexOf(normalizeRarity(r));
}

export const ACHIEVEMENT_RARITY: Record<
  Rarity,
  { label: string; border: string; glow: string }
> = {
  COMMON: { label: "Common", border: "rgba(180,190,220,0.45)", glow: "rgba(180,190,220,0.15)" },
  RARE: { label: "Rare", border: "#67C1BB", glow: "rgba(103,193,187,0.30)" },
  EPIC: { label: "Epic", border: "#C9A8DC", glow: "rgba(201,168,220,0.32)" },
  LEGENDARY: { label: "Legendary", border: "#E5875A", glow: "rgba(229,135,90,0.35)" },
  MYTHIC: { label: "Mythic", border: "#DA8B9F", glow: "rgba(218,139,159,0.40)" },
};

export const SEASON_PASS = {
  xpPerLevel: 1_000,
  maxLevel: 50,
  seasonName: "Season 1 — Ascension",
} as const;

/** Demo wallet treated as the signed-in pilot on sample screens. */
export const DEMO_SELF_ADDRESS = "0xYouSelf0000000000000000000000Angel" as const;

/**
 * XP, levels, prestige and missions: shared rules (client + server, no I/O). Spec: "Missions and XP: launch spec".
 *
 * Two numbers per pilot, both sums over one append-only ledger (lib/server/xp.ts):
 *   total XP     every positive row. Sets level + prestige. Never goes down.
 *   XP to spend  every row, purchases included (negative). The parts shop spends it.
 * Levels 1→50: level n → n+1 costs 200 + 40(n−1). An active pilot (~4,800 XP a week) hits 50 in about 12 weeks.
 * Prestige: at 50 you may prestige; level drops to 1, the badge goes up, XP to spend is untouched. Each prestige banks
 * exactly XP_PER_PRESTIGE of total XP, so XP earned past 50 carries into the next run.
 * Missions: the same 3 daily (reset 00:00 UTC) and 3 weekly (reset Monday 00:00 UTC) for everyone, drawn from the
 * pools below by a hash of the period id. Milestones are the achievement rules, paying XP by rarity.
 */

export const MAX_LEVEL = 50;
export const LEVEL_BASE_XP = 200;
export const LEVEL_STEP_XP = 40;

/** Prestige names (prestige 0 keeps the existing name). */
export const PRESTIGE_NAMES = [
  "Normie", "Acolyte", "Disciple", "Herald", "Angel", "Archangel", "Seraph", "Throne", "Dominion", "Empyrean",
] as const;
export const MAX_PRESTIGE = PRESTIGE_NAMES.length - 1;

/** XP to go from level n to n + 1. */
export const xpToNext = (n: number) => LEVEL_BASE_XP + LEVEL_STEP_XP * (n - 1);

/** Total XP needed to reach `level` from level 1 (level 1 = 0). */
export function xpForLevel(level: number): number {
  let t = 0;
  for (let n = 1; n < Math.min(level, MAX_LEVEL); n++) t += xpToNext(n);
  return t;
}
/** 56,840: total XP from level 1 to 50. */
export const XP_PER_PRESTIGE = xpForLevel(MAX_LEVEL);

export interface LevelInfo {
  level: number;
  prestige: number;
  prestigeName: string;
  /** XP into the current level */
  into: number;
  /** XP the current level needs (0 at level 50) */
  need: number;
  /** 0..1 ring fill */
  progress: number;
  canPrestige: boolean;
}

export function levelInfo(totalXp: number, prestige = 0): LevelInfo {
  const p = Math.max(0, Math.min(MAX_PRESTIGE, Math.floor(prestige)));
  let left = Math.max(0, Math.floor(totalXp) - p * XP_PER_PRESTIGE);
  let level = 1;
  while (level < MAX_LEVEL && left >= xpToNext(level)) { left -= xpToNext(level); level++; }
  const need = level >= MAX_LEVEL ? 0 : xpToNext(level);
  return {
    level, prestige: p, prestigeName: PRESTIGE_NAMES[p], into: need ? left : 0, need,
    progress: need ? left / need : 1, canPrestige: level >= MAX_LEVEL && p < MAX_PRESTIGE,
  };
}

/* ------------------------------------------------------- missions ------------------------------------------------------- */

export type Cadence = "daily" | "weekly";

export type MissionKind =
  /** qualifying boosts on N different rockets */
  | "boost_rockets"
  /** qualifying boosts worth $N in total */
  | "boost_usd"
  /** a qualifying boost on a rocket launched under an hour earlier */
  | "boost_fresh"
  /** qualifying boosts on an Easy, a Hard and an Expert rocket */
  | "boost_modes"
  /** a rocket moves up a tier while you hold it */
  | "ride_tier"
  /** a bomb (≥2% impact, ≥$10) on a rocket held ≥10 minutes */
  | "drop_bomb"
  /** hold ≥$25 of one rocket for 24 hours with no dump */
  | "hold_24h"
  /** launch a rocket (public launches only) */
  | "launch"
  /** hold a rocket when it reaches orbit */
  | "orbit_aboard";

export interface MissionDef { id: string; cadence: Cadence; kind: MissionKind; title: string; xp: number; target: number }

export const DAILY_POOL: readonly MissionDef[] = [
  { id: "d_boost3", cadence: "daily", kind: "boost_rockets", title: "Boost 3 different rockets", xp: 150, target: 3 },
  { id: "d_boost50", cadence: "daily", kind: "boost_usd", title: "Boost $50 in total", xp: 100, target: 50 },
  { id: "d_tier", cadence: "daily", kind: "ride_tier", title: "Ride a rocket up one tier", xp: 100, target: 1 },
  { id: "d_fresh", cadence: "daily", kind: "boost_fresh", title: "Boost a rocket launched in the last hour", xp: 100, target: 1 },
  { id: "d_bomb", cadence: "daily", kind: "drop_bomb", title: "Drop a bomb", xp: 75, target: 1 },
  { id: "d_modes", cadence: "daily", kind: "boost_modes", title: "Boost an Easy, a Hard and an Expert rocket", xp: 200, target: 3 },
];
export const WEEKLY_POOL: readonly MissionDef[] = [
  { id: "w_boost10", cadence: "weekly", kind: "boost_rockets", title: "Boost 10 different rockets", xp: 600, target: 10 },
  { id: "w_hold", cadence: "weekly", kind: "hold_24h", title: "Stay aboard one rocket for 24 hours", xp: 500, target: 1 },
  { id: "w_launch", cadence: "weekly", kind: "launch", title: "Launch a rocket", xp: 750, target: 1 },
  { id: "w_orbit", cadence: "weekly", kind: "orbit_aboard", title: "Be aboard when a rocket reaches orbit", xp: 1000, target: 1 },
];
export const MISSIONS_PER_PERIOD = 3;
export const missionById = (id: string) => [...DAILY_POOL, ...WEEKLY_POOL].find((m) => m.id === id);

/** Fair-play thresholds (spec "Fair play"). */
export const FAIR = {
  /** a boost counts only at $5 or more */
  minBoostUsd: 5,
  /** a boost sold again within this window is a round trip and doesn't count */
  washMs: 2 * 60_000,
  /** staying aboard needs this much held */
  holdMinUsd: 25,
  holdMs: 24 * 3600_000,
  /** bombs count only on rockets held this long */
  bombMinHoldMs: 10 * 60_000,
  bombMinImpactBps: 200,
  bombMinUsd: 10,
  freshLaunchMs: 3600_000,
} as const;

const DAY = 86_400_000;

export interface Period { id: string; cadence: Cadence; start: number; end: number }

/** "d:2026-11-12" — UTC day containing ts. */
export function dayPeriod(ts: number): Period {
  const start = Math.floor(ts / DAY) * DAY;
  return { id: `d:${new Date(start).toISOString().slice(0, 10)}`, cadence: "daily", start, end: start + DAY };
}
/** "w:2026-11-09" — UTC week (Monday start) containing ts. */
export function weekPeriod(ts: number): Period {
  const day = Math.floor(ts / DAY) * DAY;
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  const start = day - dow * DAY;
  return { id: `w:${new Date(start).toISOString().slice(0, 10)}`, cadence: "weekly", start, end: start + 7 * DAY };
}

/** FNV-1a 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** The same 3 missions for everyone in a period: a seeded shuffle of the pool, keyed by the period id. */
export function missionsFor(p: Period): MissionDef[] {
  const pool = [...(p.cadence === "daily" ? DAILY_POOL : WEEKLY_POOL)];
  let seed = hash(p.id) || 1;
  for (let i = pool.length - 1; i > 0; i--) {
    seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) >>> 0;
    const j = seed % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, MISSIONS_PER_PERIOD);
}

/* ------------------------------------------------------ milestones ------------------------------------------------------ */

export const MILESTONE_XP_BY_RARITY: Record<string, number> = { COMMON: 100, RARE: 250, EPIC: 600, LEGENDARY: 1500, MYTHIC: 4000 };
/** Per-milestone overrides: First boost 100, First launch 500. */
export const MILESTONE_XP_OVERRIDE: Record<string, number> = { first_blessing: 100, pad_ignition: 500 };
/** Player-facing name + one line per live milestone (the achievement rules the server scores, lib/achievements V1_RULES). */
export const MILESTONE_COPY: Record<string, { name: string; desc: string }> = {
  first_blessing: { name: "First boost", desc: "Boost any rocket." },
  pad_ignition: { name: "First launch", desc: "Launch your first rocket." },
  graduated_dev: { name: "Blessed Dev", desc: "Launch a rocket that reaches orbit." },
  through_pearly_gates: { name: "Outer Space", desc: "Be aboard with $10 or more when a rocket reaches orbit." },
  final_boost: { name: "Final Push", desc: "Make the boost that sends a rocket to orbit." },
  first_grenade: { name: "Pin Pulled", desc: "Drop a grenade: a $10+ dump that moves the price 2%." },
  cruise_missile_ach: { name: "Cruise Control", desc: "Drop a cruise missile: a $25+ dump that moves the price 12%." },
  nuke_ach: { name: "Nuke", desc: "Drop a nuke: a $50+ dump that moves the price 25%." },
  unfumbled: { name: "Unfumbled", desc: "Take $500 profit in one sale." },
  best_x_10: { name: "Tenfold Halo", desc: "Sell at 10× what you paid, on $10 or more." },
};
export const milestoneXp = (id: string, rarity: string) => MILESTONE_XP_OVERRIDE[id] ?? MILESTONE_XP_BY_RARITY[rarity.toUpperCase()] ?? 100;

/* --------------------------------------------------------- API ---------------------------------------------------------- */

export interface MissionStatus { id: string; title: string; xp: number; progress: number; target: number; done: boolean }
export interface XpSummary {
  wallet: string;
  totalXp: number;
  spendableXp: number;
  level: LevelInfo;
  daily: { period: string; resetsAt: number; missions: MissionStatus[] };
  weekly: { period: string; resetsAt: number; missions: MissionStatus[] };
  /** parts bought in the shop (catalogue ids) */
  owned: string[];
  /** newest first, at most 20 */
  recent: { label: string; xp: number; ts: number }[];
  evaluatedAt: number | null;
}

/** "+150 XP" */
export const xpLabel = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US")} XP`;

/* ---------------------------------------------------- signed writes ----------------------------------------------------- */

const SIGN_FOOTER = "Signing proves you own this wallet. It costs nothing and sends no transaction.";
export const shopBuyMessage = (address: string, partId: string, nonce: string) =>
  `DISCIPLE: unlock a rocket part with XP\n\nWallet: ${address.toLowerCase()}\nPart: ${partId}\nNonce: ${nonce}\n\n${SIGN_FOOTER}`;
export const prestigeMessage = (address: string, nonce: string) =>
  `DISCIPLE: prestige\n\nWallet: ${address.toLowerCase()}\nNonce: ${nonce}\n\nYour level goes back to 1 and your prestige goes up.\n\n${SIGN_FOOTER}`;

/**
 * Milestones: the achievement rules the server scores from on-chain data (lib/server/achievements.ts), each paying XP
 * by rarity (lib/xp.ts). Player-facing names and one-liners live in lib/xp.ts MILESTONE_COPY.
 */
import { ACHIEVEMENT_RARITY, normalizeRarity, rarityRank, type AchievementRarity } from "./config";
import { MILESTONE_COPY } from "./xp";

/** Frame style for a rarity; legacy keys (BLESSED/ANOINTED/…) resolve via LEGACY_RARITY_ALIASES. */
export function rarityStyle(rarity: AchievementRarity | string) {
  return ACHIEVEMENT_RARITY[normalizeRarity(rarity)];
}

/** Themed SVG icon (web/public/achievements/<id>.svg), one per milestone id. */
export function achievementIconPath(id: string): string {
  return `/achievements/${id}.svg`;
}

/** A milestone as a small badge (leaderboard rows, profile chips). */
export interface MilestoneBadge { id: string; name: string; rarity: AchievementRarity | string; description: string }

/* =================================================================================================================
 * V1 REAL-DATA RULES — shared by SITE (server engine: lib/server/achievements.ts, /api/cron/achievements,
 * GET /api/achievements) and GAME (client, toasts). GAME OWNS THE RULE DATA below (ids, names, rarities, criteria,
 * thresholds); SITE owns the engine that evaluates a criteria `kind`. Adding a rule with an existing kind (e.g.
 * atom_bomber = sell_impact ≥ 5000 bps) needs no engine change. A NEW kind needs an evaluator case in
 * lib/achievementsEval.ts (SITE).
 * Source: disciple-notes/v1-achievements-plan.md (GAME, Oct 26). Every $ is the PLAYER $: net USDG paid on a buy
 * (usdIn net of UsdgRefund), USDG received on a sell (usdOut), else the quote value (Fill.usd) — lib/trades playerUsd.
 * Bumping V1_RULES_VERSION re-scores every wallet on the next cron (rules changed ⇒ replay; unlocks never revoked).
 * ================================================================================================================= */

/** What a rule checks. Thresholds are inclusive (≥). Impact is uncapped on-chain (live router maxImpactBps = 100000). */
export type AchievementCriteria =
  /** a buy (curve or hook) whose player $ ≥ minUsd */
  | { kind: "buy"; minUsd: number }
  /** wallet is Launched.creator of a coin (anon/private launches never count — GAME Q4) */
  | { kind: "launch" }
  /** a coin the wallet launched (public) emits GraduatedToV4 */
  | { kind: "launch_graduated" }
  /** at the coin's GraduatedToV4 (block, logIndex): wallet's net CURVE tokens > 0 and its curve buys on it total ≥ minCurveBuyUsd */
  | { kind: "held_through_graduation"; minCurveBuyUsd: number }
  /** wallet is the trader on the curve buy in the SAME tx as GraduatedToV4 (just before it); net player $ ≥ minUsd */
  | { kind: "graduating_buy"; minUsd: number }
  /** a sell with Trade.impactBps ≥ minImpactBps and player $ (usdOut) ≥ minUsd */
  | { kind: "sell_impact"; minImpactBps: number; minUsd: number }
  /** a sell whose realized profit (usdOut − average-cost basis of the tokens sold) ≥ minProfitUsd */
  | { kind: "realized_profit"; minProfitUsd: number }
  /** a sell realized at ≥ minMultiple × (usdOut ÷ basis of the tokens sold), with that basis ≥ minBasisUsd */
  | { kind: "realized_multiple"; minMultiple: number; minBasisUsd: number };

export type AchievementCriteriaKind = AchievementCriteria["kind"];

/** One V1 rule (GAME-owned data). `target` = the progress denominator the API reports (1 for one-shot rules). */
export interface AchievementRule {
  id: string;
  name: string;
  rarity: AchievementRarity;
  criteria: AchievementCriteria;
  target?: number;
}
export type Rule = AchievementRule;

/** Bump when V1_RULES changes in a way that should re-score existing wallets (SITE cron replays; unlocks are kept). */
export const V1_RULES_VERSION = 1;

/** GAME's 10 V1 picks (v1-achievements-plan.md). atom_bomber (11th) is GAME's to add on game/achievements. */
export const V1_RULES: readonly AchievementRule[] = [
  { id: "first_blessing", name: "First Blessing", rarity: "COMMON", criteria: { kind: "buy", minUsd: 1 } },
  { id: "pad_ignition", name: "Pad Ignition", rarity: "COMMON", criteria: { kind: "launch" } },
  { id: "graduated_dev", name: "Blessed Dev", rarity: "EPIC", criteria: { kind: "launch_graduated" } },
  { id: "through_pearly_gates", name: "Outer Space", rarity: "RARE", criteria: { kind: "held_through_graduation", minCurveBuyUsd: 10 } },
  { id: "final_boost", name: "Final Push", rarity: "RARE", criteria: { kind: "graduating_buy", minUsd: 1 } },
  { id: "first_grenade", name: "Pin Pulled", rarity: "COMMON", criteria: { kind: "sell_impact", minImpactBps: 200, minUsd: 10 } },
  { id: "cruise_missile_ach", name: "Cruise Control", rarity: "RARE", criteria: { kind: "sell_impact", minImpactBps: 1200, minUsd: 25 } },
  { id: "nuke_ach", name: "Nuke", rarity: "EPIC", criteria: { kind: "sell_impact", minImpactBps: 2500, minUsd: 50 } },
  { id: "unfumbled", name: "Unfumbled", rarity: "EPIC", criteria: { kind: "realized_profit", minProfitUsd: 500 } },
  { id: "best_x_10", name: "Tenfold Halo", rarity: "EPIC", criteria: { kind: "realized_multiple", minMultiple: 10, minBasisUsd: 10 } },
];

export const v1RuleById = (id: string): AchievementRule | undefined => V1_RULES.find((r) => r.id === id);

/* ---------- evaluator input (what SITE's engine feeds lib/achievementsEval, in (block, logIndex) order) ---------- */

/** On-chain position of an event: the unlock proof. `ts` = block time, ms. */
export interface AchEventRef { tx: string; block: number; logIndex: number; ts: number }

/** One indexed Trade (KV Fill), already in player $. */
export interface AchFillEvent extends AchEventRef {
  kind: "fill";
  /** Fill.id = `${tx}:${logIndex}` */
  id: string;
  coin: string;
  wallet: string;
  side: "buy" | "sell";
  venue: "curve" | "hook";
  tokens: number;
  /** player $ (lib/trades playerUsd): net usdIn on buys, usdOut on sells, else Fill.usd */
  usd: number;
  /** Trade.impactBps (unsigned, uncapped). Absent on fills indexed before FILL_V 3 ⇒ sell_impact can't fire for them. */
  impactBps?: number;
}
/** Launchpad.Launched (anon = launched via AnonLauncher; never credited). */
export interface AchLaunchEvent extends AchEventRef { kind: "launch"; coin: string; creator: string; anon: boolean }
/** BondingCurve.GraduatedToV4 (emitter verified = the coin's curve). */
export interface AchGraduationEvent extends AchEventRef { kind: "graduation"; coin: string }
export type AchEvent = AchFillEvent | AchLaunchEvent | AchGraduationEvent;

/** Running per-(wallet, coin) state the evaluator keeps between events (stored by SITE). Average-cost basis. */
export interface AchPosition {
  /** tokens held from own buys − sells (all venues; transfers ignored, like stats.ts) */
  tokens: number;
  /** $ cost basis of `tokens` (average cost) */
  basisUsd: number;
  /** net curve tokens (curve buys − curve sells) — held_through_graduation */
  curveTokens: number;
  /** $ of curve buys on this coin (player $) */
  curveBuyUsd: number;
}

/** One unlock with its proof (what GET /api/achievements and the feed return per unlocked id). */
export interface AchievementUnlockRecord extends AchEventRef {
  id: string;
  wallet: string;
  coin?: string;
}

/** Up to n milestone badges for these ids, rarest first (unknown ids are skipped). */
export function milestoneBadges(ids: readonly string[], n = 6): MilestoneBadge[] {
  return ids
    .map((id) => V1_RULES.find((r) => r.id === id))
    .filter((r): r is AchievementRule => !!r)
    .sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity))
    .slice(0, n)
    .map((r) => ({ id: r.id, name: MILESTONE_COPY[r.id]?.name ?? r.name, rarity: r.rarity, description: MILESTONE_COPY[r.id]?.desc ?? "" }));
}

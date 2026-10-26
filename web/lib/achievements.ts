import { prestigeFromPoints } from "./prestige";
/**
 * 43 DISCIPLE achievements — angel/CT names, rarity frames, rewards.
 * Trimmed from 50 (dropped near-duplicates / filler); the page groups them by category.
 */
import { ACHIEVEMENT_RARITY, BOMB_PCT, SEASON_PASS, normalizeRarity, rarityRank, type AchievementRarity } from "./config";
import type { PlayerStats } from "./stats";

export type AchievementCategory =
  | "flight" | "crew" | "bombs" | "conviction" | "launcher" | "trencher" | "seasonal" | "tramps";

export interface AchievementReward {
  points?: number; skin?: string; trail?: string; frame?: string;
}

export interface AchievementDef {
  id: string; name: string; description: string; category: AchievementCategory;
  rarity: AchievementRarity; target: number; reward: AchievementReward;
  progress: (s: PlayerStats) => number;
}

export const ACHIEVEMENT_CATEGORIES: { id: AchievementCategory; label: string }[] = [
  { id: "flight", label: "Flight" },
  { id: "crew", label: "Crew" },
  { id: "bombs", label: "Bombs" },
  { id: "conviction", label: "Conviction" },
  { id: "launcher", label: "Launcher" },
  { id: "trencher", label: "Trencher" },
  { id: "seasonal", label: "Seasonal" },
  { id: "tramps", label: "Tramps & Walls" },
];

const A = (
  id: string, name: string, description: string, category: AchievementCategory,
  rarity: AchievementRarity, target: number, reward: AchievementReward,
  progress: (s: PlayerStats) => number,
): AchievementDef => ({ id, name, description, category, rarity, target, reward, progress });

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  A("first_blessing", "First Blessing", "BOOST your first rocket ($1+).", "flight", "COMMON", 1, { points: 50 }, (s) => Math.min(s.metrics.buyCount, 1)),
  A("final_boost", "Final Push", "Make the buy that graduates a rocket ($1+).", "flight", "RARE", 1, { points: 300 }, () => 0),   // real data only (graduating buy); no PlayerStats signal
  A("through_pearly_gates", "Outer Space", "Hold a rocket you BOOSTED through graduation ($33,333).", "flight", "RARE", 1, { points: 250, frame: "Pearly Frame" }, (s) => s.ct.graduationsWitnessed),
  A("seventh_heaven", "Seventh Heaven", "Ride a rocket into Seventh Heaven tier.", "flight", "MYTHIC", 1, { points: 5000, skin: "Empyrean Hull", trail: "Halo Gold" }, (s) => s.rockets.filter((r) => r.tierIndex >= 17).length),
  A("firmament_walker", "Firmament Walker", "Cross into Firmament ($55K+).", "flight", "RARE", 1, { points: 300, trail: "Star Wake" }, (s) => s.rockets.filter((r) => r.tierIndex >= 5).length),
  A("angel_altitude", "Angel Altitude", "Hit the Morning Stars tier ($100K+).", "flight", "EPIC", 1, { points: 750, frame: "Winged Border" }, (s) => s.rockets.filter((r) => r.tierIndex >= 6).length),
  A("seraphim_sight", "Seraphim Sight", "Reach Seraphim altitude.", "flight", "LEGENDARY", 1, { points: 2000, skin: "Seraph Chrome" }, (s) => s.rockets.filter((r) => r.tierIndex >= 14).length),
  A("best_x_10", "Tenfold Halo", "Sell for 10× what you paid (realized).", "flight", "EPIC", 10, { points: 1000, trail: "Golden Multipath" }, (s) => Math.floor(s.metrics.bestRealizedX ?? 0)),
  A("best_x_50", "Fiftyfold Glory", "Sell for 50× what you paid (realized).", "flight", "LEGENDARY", 50, { points: 4000, skin: "Glory Nosecone" }, (s) => Math.floor(s.metrics.bestRealizedX ?? 0)),
  A("crew_captain_ach", "Crew Captain", "Be the top booster on a graduated rocket.", "crew", "EPIC", 1, { points: 800, frame: "Captain Crest" }, (s) => s.metrics.crewCaptainGrads),
  A("gate_keeper_ach", "Gate Keeper", "Help push 3 rockets into Outer Space.", "crew", "RARE", 3, { points: 600, trail: "Gate Spark" }, (s) => s.metrics.gateKeeperAssists),
  A("choir_of_three", "Choir of Three", "Join 3 different crews.", "crew", "COMMON", 3, { points: 100 }, (s) => s.rings.find((r) => r.key === "crews")?.value ?? 0),
  A("full_congregation", "Full Congregation", "Join 12 crews.", "crew", "EPIC", 12, { points: 900, frame: "Congregation" }, (s) => s.rings.find((r) => r.key === "crews")?.value ?? 0),
  A("first_grenade", "Pin Pulled", "Drop your first grenade (≥2% impact).", "bombs", "COMMON", 1, { points: 40 }, (s) => Math.min(s.metrics.bombCount, 1)),
  A("cruise_missile_ach", "Cruise Control", "Drop a cruise missile (≥12% impact).", "bombs", "RARE", 1, { points: 200, trail: "Smoke Trail" }, (s) => Math.min(s.metrics.cruiseCount ?? 0, 1)),
  A("nuke_ach", "Nuke", "Drop a nuke (≥25% impact).", "bombs", "EPIC", 1, { points: 700, frame: "Fallout Rim" }, (s) => Math.min(s.metrics.nukeCount, 1)),
  A("atom_bomber", "Atom Bomber", "Detonate an atom bomb (≥50% impact).", "bombs", "LEGENDARY", 1, { points: 2500, skin: "Atom Warhead", trail: "Mushroom Wake" }, (s) => Math.min(s.metrics.atomCount ?? 0, 1)),
  A("carpet_bomber", "Carpet Bomber", "Drop 15 bombs.", "bombs", "EPIC", 15, { points: 1000 }, (s) => s.metrics.bombCount),
  A("diamond_halo", "Diamond Halo", "Hold through a −50% drawdown.", "conviction", "EPIC", 1, { points: 900, frame: "Diamond Halo" }, (s) => s.metrics.diamondHandsCount),
  A("believer_badge", "True Believer", "Average hold time ≥ 12 hours.", "conviction", "RARE", 12, { points: 350, trail: "Patience Gold" }, (s) => Math.floor(s.metrics.avgHoldHours)),
  A("round_tripper", "Round Tripper", "Go +2× then close at a loss.", "conviction", "COMMON", 1, { points: 60 }, (s) => s.ct.roundsTripped),
  A("iron_seat", "Iron Seat", "Hold any position for 48 hours continuous.", "conviction", "RARE", 48, { points: 500 }, (s) => Math.floor(s.metrics.openHoldHours || s.metrics.avgHoldHours)),
  A("unfumbled", "Unfumbled", "Realize a +$500 close.", "conviction", "EPIC", 500, { points: 800 }, (s) => Math.max(0, Math.floor(s.ct.biggestW))),
  A("bag_redemption", "Bag Redemption", "Hold a diamond drawdown and still bank a W.", "conviction", "LEGENDARY", 1, { points: 1500, skin: "Redeemed Hull" }, (s) => (s.metrics.diamondHandsCount >= 1 && s.ct.biggestW > 0 ? 1 : 0)),
  A("pad_ignition", "Pad Ignition", "Launch your first rocket.", "launcher", "COMMON", 1, { points: 200, frame: "Ignition Ring" }, (s) => s.metrics.launches),
  A("graduated_dev", "Blessed Dev", "Graduate a rocket you launched.", "launcher", "EPIC", 1, { points: 1200, trail: "Creator Wake" }, (s) => s.metrics.graduatedLaunches),
  A("serial_launcher", "Serial Launcher", "Launch 5 rockets.", "launcher", "RARE", 5, { points: 600 }, (s) => s.metrics.launches),
  A("kingmaker_ach", "Kingmaker", "BOOST 2 rockets early, then ride them into Morning Stars+.", "launcher", "LEGENDARY", 2, { points: 2000, frame: "Kingmaker Crown" }, (s) => s.metrics.kingmakerCount),
  A("trench_warfare", "Trench Warfare", "Log 40 trades with avg hold under 8 minutes.", "trencher", "RARE", 40, { points: 400, trail: "Dirt Wake" }, (s) => s.metrics.avgHoldHours * 60 <= 8 ? s.metrics.tradeCount : Math.min(s.metrics.tradeCount, 20)),
  A("flip_artist", "Flip Artist", "Complete 25 quick flips (<15 min holds).", "trencher", "COMMON", 25, { points: 180 }, (s) => s.playstyle.quickFlips),
  A("sniper_nest", "Sniper Nest", "Land 10 snipes in the first 2 minutes.", "trencher", "EPIC", 10, { points: 700, frame: "Scope Rim" }, (s) => Math.round(s.metrics.sniperBuyFraction * s.metrics.buyCount)),
  A("degen_passport", "Degen Passport", "Trade 15 distinct rockets.", "trencher", "RARE", 15, { points: 350 }, (s) => s.metrics.distinctRockets),
  A("season_initiate", "Season Initiate", "Reach season rank Ascendant.", "seasonal", "COMMON", 1, { points: 100 }, (s) => ["ASCENDANT", "BLESSED", "ANOINTED", "GLORIFIED", "DIVINE"].includes(s.rank.tier) ? 1 : 0),
  A("season_blessed", "Season Blessed", "Reach season rank Blessed.", "seasonal", "RARE", 1, { points: 300, frame: "Season Blessed" }, (s) => ["BLESSED", "ANOINTED", "GLORIFIED", "DIVINE"].includes(s.rank.tier) ? 1 : 0),
  A("season_anointed", "Season Anointed", "Reach season rank Anointed.", "seasonal", "EPIC", 1, { points: 1000, skin: "Anointed Livery" }, (s) => ["ANOINTED", "GLORIFIED", "DIVINE"].includes(s.rank.tier) ? 1 : 0),
  A("top_percentile", "Top of the Choir", "Finish in the top 5% of the leaderboard.", "seasonal", "LEGENDARY", 5, { points: 3000, trail: "Choir Light" }, (s) => (s.leaderboardTopPct <= 5 ? 5 : Math.max(0, 10 - s.leaderboardTopPct))),
  A("rhalo_stacker", "rHALO Stacker", "Earn 10,000 season points.", "seasonal", "EPIC", 10000, { points: 500 }, (s) => s.points),
  A("first_bounce", "First Bounce", "Get a tramp filled — the rocket bounced off your support.", "tramps", "COMMON", 1, { points: 150 }, (s) => s.metrics.trampsFilled ?? 0),
  A("trampoline_saint", "Trampoline Saint", "Get 10 tramps filled.", "tramps", "EPIC", 10, { points: 1200, trail: "Spring Halo" }, (s) => s.metrics.trampsFilled ?? 0),
  A("holy_safety_net", "Holy Safety Net", "Fill a $1K+ tramp.", "tramps", "RARE", 1, { points: 500, frame: "Safety Net" }, (s) => s.metrics.bigTrampsFilled ?? 0),
  A("wall_of_jericho", "Wall of Jericho", "Have a wall broken through (filled).", "tramps", "COMMON", 1, { points: 175 }, (s) => s.metrics.wallsFilled ?? 0),
  A("stonemason", "Stonemason", "Get 10 walls filled.", "tramps", "EPIC", 10, { points: 1400, skin: "Marble Hull" }, (s) => s.metrics.wallsFilled ?? 0),
  A("gatekeeper_of_range", "Range Warden", "Fill 25 tramps + walls combined.", "tramps", "LEGENDARY", 25, { points: 3500, frame: "Warden Crest" }, (s) => (s.metrics.trampsFilled ?? 0) + (s.metrics.wallsFilled ?? 0)),
  A("pass_level_25", "Halfway to Heaven", "Reach prestige level 25.", "seasonal", "RARE", 25, { points: 400, frame: "Level 25" }, (s) => Math.min(25, prestigeFromPoints(s.points).level)),
];

export type AchievementState = "locked" | "in_progress" | "unlocked";

export interface AchievementView extends AchievementDef {
  state: AchievementState; current: number; pct: number;
}

export function evaluateAchievements(stats: PlayerStats): AchievementView[] {
  return ACHIEVEMENTS.map((a) => {
    const current = Math.max(0, a.progress(stats));
    const pct = Math.min(100, (current / a.target) * 100);
    const state: AchievementState = current >= a.target ? "unlocked" : current > 0 ? "in_progress" : "locked";
    return { ...a, current: Math.min(current, a.target), pct, state };
  });
}

export function topBadgesFromAchievements(views: AchievementView[], n = 3) {
  return views
    .filter((v) => v.state === "unlocked")
    .sort((a, b) => {
      return rarityRank(b.rarity) - rarityRank(a.rarity);
    })
    .slice(0, n)
    .map((v) => ({ id: v.id, name: v.name, rarity: v.rarity }));
}

export function seasonPassProgress(points: number) {
  const raw = Math.floor(points / SEASON_PASS.xpPerLevel);
  const level = Math.min(SEASON_PASS.maxLevel, Math.max(1, raw + 1));
  const into = points % SEASON_PASS.xpPerLevel;
  return {
    level, into, need: SEASON_PASS.xpPerLevel, progress: into / SEASON_PASS.xpPerLevel,
    seasonName: SEASON_PASS.seasonName, maxLevel: SEASON_PASS.maxLevel,
  };
}


/** Display glyphs / fills for leaderboard square badges */
export const ACHIEVEMENT_DISPLAY: Record<string, { icon: string; color: string }> = {
  first_blessing: { icon: "🚀", color: "#85B0D6" },
  through_pearly_gates: { icon: "🚪", color: "#B3B6E6" },
  seventh_heaven: { icon: "☁️", color: "#E8EAEE" },
  firmament_walker: { icon: "🌌", color: "#C9A8DC" },
  angel_altitude: { icon: "👼", color: "#DE9A73" },
  seraphim_sight: { icon: "✨", color: "#B3B6E6" },
  best_x_10: { icon: "📈", color: "#DE9A73" },
  best_x_50: { icon: "🏆", color: "#E5875A" },
  crew_captain_ach: { icon: "👑", color: "#E5875A" },
  gate_keeper_ach: { icon: "🔑", color: "#BCABE3" },
  choir_of_three: { icon: "🪽", color: "#70BACD" },
  full_congregation: { icon: "👥", color: "#C9A8DC" },
  first_grenade: { icon: "💣", color: "#DA8B9F" },
  cruise_missile_ach: { icon: "🚀", color: "#DD7A72" },
  nuke_ach: { icon: "☢️", color: "#DD7A72" },
  atom_bomber: { icon: "💥", color: "#E0667E" },
  carpet_bomber: { icon: "🌩️", color: "#DA8B9F" },
  diamond_halo: { icon: "💎", color: "#8EB8E0" },
  believer_badge: { icon: "🙏", color: "#DE9A73" },
  round_tripper: { icon: "🔄", color: "#A9AFBC" },
  iron_seat: { icon: "⏳", color: "#DE9A73" },
  unfumbled: { icon: "💰", color: "#77C591" },
  bag_redemption: { icon: "🎒", color: "#C9A8DC" },
  pad_ignition: { icon: "🕯️", color: "#D9A07E" },
  graduated_dev: { icon: "🎓", color: "#C9A8DC" },
  serial_launcher: { icon: "🛫", color: "#E5875A" },
  kingmaker_ach: { icon: "👑", color: "#E5875A" },
  trench_warfare: { icon: "⛏️", color: "#6EC4A4" },
  flip_artist: { icon: "🎴", color: "#77C591" },
  sniper_nest: { icon: "🎯", color: "#77C591" },
  degen_passport: { icon: "🛂", color: "#D392B8" },
  season_initiate: { icon: "⭐", color: "#85B0D6" },
  season_blessed: { icon: "🌟", color: "#DE9A73" },
  season_anointed: { icon: "✦", color: "#C9A8DC" },
  top_percentile: { icon: "🏅", color: "#E5875A" },
  rhalo_stacker: { icon: "✨", color: "#B3B6E6" },
  pass_level_25: { icon: "📜", color: "#C9A8DC" },
  final_boost: { icon: "⛽", color: "#B3B6E6" },   // placeholder glyph/colour (BRAND)
  // Tramps & walls: placeholder glyphs/colours until BRAND supplies them (were falling back to ⭐).
  first_bounce: { icon: "🤸", color: "#77C591" },
  trampoline_saint: { icon: "😇", color: "#6EC4A4" },
  holy_safety_net: { icon: "🥅", color: "#85B0D6" },
  wall_of_jericho: { icon: "🧱", color: "#DD7A72" },
  stonemason: { icon: "🪨", color: "#A9AFBC" },
  gatekeeper_of_range: { icon: "🛡️", color: "#E5875A" },
};

/** Frame style for a rarity; legacy keys (BLESSED/ANOINTED/…) resolve via LEGACY_RARITY_ALIASES. */
export function rarityStyle(rarity: AchievementRarity | string) {
  return ACHIEVEMENT_RARITY[normalizeRarity(rarity)];
}

export function achievementById(id: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

/** Pick up to n highest-rarity achievements from catalog ids. */
export function topAchievements(ids: string[], n = 6): AchievementDef[] {
  return ids
    .map((id) => achievementById(id))
    .filter((a): a is AchievementDef => !!a)
    .sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity))
    .slice(0, n);
}

/** Themed SVG icon (web/public/achievements/<id>.svg) — one per achievement id. */
export function achievementIconPath(id: string): string {
  return `/achievements/${id}.svg`;
}

export function achievementDisplay(id: string): { icon: string; color: string } {
  return ACHIEVEMENT_DISPLAY[id] ?? { icon: "⭐", color: "#DE9A73" };
}

/** "+250 pts · Pearly Frame" (achievement cards, loot popup). */
export function rewardPreview(a: Pick<AchievementDef, "reward">): string {
  const bits: string[] = [];
  if (a.reward.points) bits.push(`+${a.reward.points} pts`);
  if (a.reward.skin) bits.push(a.reward.skin);
  if (a.reward.trail) bits.push(a.reward.trail);
  if (a.reward.frame) bits.push(a.reward.frame);
  return bits.join(" · ") || "—";
}

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
export const V1_RULES_VERSION = 2;   // 2: + atom_bomber (GAME)

/** GAME's 10 V1 picks (v1-achievements-plan.md) + atom_bomber (11th). Thresholds: lib/config BOMB_PCT (2 / 12 / 25 / 50 %). */
export const V1_RULES: readonly AchievementRule[] = [
  { id: "first_blessing", name: "First Blessing", rarity: "COMMON", criteria: { kind: "buy", minUsd: 1 } },
  { id: "pad_ignition", name: "Pad Ignition", rarity: "COMMON", criteria: { kind: "launch" } },
  { id: "graduated_dev", name: "Blessed Dev", rarity: "EPIC", criteria: { kind: "launch_graduated" } },
  { id: "through_pearly_gates", name: "Outer Space", rarity: "RARE", criteria: { kind: "held_through_graduation", minCurveBuyUsd: 10 } },
  { id: "final_boost", name: "Final Push", rarity: "RARE", criteria: { kind: "graduating_buy", minUsd: 1 } },
  { id: "first_grenade", name: "Pin Pulled", rarity: "COMMON", criteria: { kind: "sell_impact", minImpactBps: BOMB_PCT.GRENADE * 100, minUsd: 10 } },
  { id: "cruise_missile_ach", name: "Cruise Control", rarity: "RARE", criteria: { kind: "sell_impact", minImpactBps: BOMB_PCT.CRUISE * 100, minUsd: 25 } },
  { id: "nuke_ach", name: "Nuke", rarity: "EPIC", criteria: { kind: "sell_impact", minImpactBps: BOMB_PCT.NUKE * 100, minUsd: 50 } },
  // 11th (GAME): one sell at ≥ 50% impact (ATOM tier). $100 floor is GAME's proposal (open question for lee).
  { id: "atom_bomber", name: "Atom Bomber", rarity: "LEGENDARY", criteria: { kind: "sell_impact", minImpactBps: BOMB_PCT.ATOM * 100, minUsd: 100 } },
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

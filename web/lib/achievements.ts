/**
 * ~40 DISCIPLE achievements — angel/CT names, rarity frames, rewards.
 */
import { ACHIEVEMENT_RARITY, SEASON_PASS, type AchievementRarity } from "./config";
import type { PlayerStats } from "./stats";

export type AchievementCategory =
  | "flight" | "crew" | "bombs" | "conviction" | "launcher" | "trencher" | "seasonal";

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
];

const A = (
  id: string, name: string, description: string, category: AchievementCategory,
  rarity: AchievementRarity, target: number, reward: AchievementReward,
  progress: (s: PlayerStats) => number,
): AchievementDef => ({ id, name, description, category, rarity, target, reward, progress });

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  A("first_blessing", "First Blessing", "Fuel your first rocket.", "flight", "COMMON", 1, { points: 50 }, (s) => s.metrics.distinctRockets),
  A("through_pearly_gates", "Through the Pearly Gates", "Witness a rocket graduate ($33K).", "flight", "BLESSED", 1, { points: 250, frame: "Pearly Frame" }, (s) => s.ct.graduationsWitnessed),
  A("seventh_heaven", "Seventh Heaven", "Ride a rocket into Seventh Heaven tier.", "flight", "DIVINE", 1, { points: 5000, skin: "Empyrean Hull", trail: "Halo Gold" }, (s) => s.rockets.filter((r) => r.tierIndex >= 17).length),
  A("narrow_gate", "Narrow Gate", "Reach Narrow Gate tier on any rocket.", "flight", "COMMON", 1, { points: 75 }, (s) => s.rockets.filter((r) => r.tierIndex >= 3).length),
  A("firmament_walker", "Firmament Walker", "Cross into Firmament ($55K+).", "flight", "BLESSED", 1, { points: 300, trail: "Star Wake" }, (s) => s.rockets.filter((r) => r.tierIndex >= 5).length),
  A("angel_altitude", "Angel Altitude", "Hit the Angels tier ($100K+).", "flight", "ANOINTED", 1, { points: 750, frame: "Winged Border" }, (s) => s.rockets.filter((r) => r.tierIndex >= 6).length),
  A("seraphim_sight", "Seraphim Sight", "Reach Seraphim altitude.", "flight", "GLORIFIED", 1, { points: 2000, skin: "Seraph Chrome" }, (s) => s.rockets.filter((r) => r.tierIndex >= 14).length),
  A("tier_tourist", "Tier Tourist", "Touch 8 different altitude tiers across rockets.", "flight", "BLESSED", 8, { points: 400 }, (s) => new Set(s.rockets.map((r) => r.tierIndex)).size),
  A("best_x_10", "Tenfold Halo", "Book a 10× multiple on any rocket.", "flight", "ANOINTED", 10, { points: 1000, trail: "Golden Multipath" }, (s) => Math.floor(s.rings.find((r) => r.key === "bestx")?.value ?? 1)),
  A("best_x_50", "Fiftyfold Glory", "Book a 50× multiple.", "flight", "GLORIFIED", 50, { points: 4000, skin: "Glory Nosecone" }, (s) => Math.floor(s.rings.find((r) => r.key === "bestx")?.value ?? 1)),
  A("crew_captain_ach", "Crew Captain", "Be top fueler on a graduated rocket.", "crew", "ANOINTED", 1, { points: 800, frame: "Captain Crest" }, (s) => s.metrics.crewCaptainGrads),
  A("gate_keeper_ach", "Gate Keeper", "Help push 3 rockets through Pearly Gates.", "crew", "BLESSED", 3, { points: 600, trail: "Gate Spark" }, (s) => s.metrics.gateKeeperAssists),
  A("choir_of_three", "Choir of Three", "Join 3 different crews.", "crew", "COMMON", 3, { points: 100 }, (s) => s.rings.find((r) => r.key === "crews")?.value ?? 0),
  A("full_congregation", "Full Congregation", "Join 12 crews.", "crew", "ANOINTED", 12, { points: 900, frame: "Congregation" }, (s) => s.rings.find((r) => r.key === "crews")?.value ?? 0),
  A("co_fueler", "Co-Fueler", "Log 20 fuel buys across shared climbs.", "crew", "COMMON", 20, { points: 150 }, (s) => s.metrics.buyCount),
  A("ascension_assist", "Ascension Assist", "Witness 5 graduations.", "crew", "BLESSED", 5, { points: 500 }, (s) => s.ct.graduationsWitnessed),
  A("first_grenade", "Pin Pulled", "Drop your first grenade (≥2% impact).", "bombs", "COMMON", 1, { points: 40 }, (s) => Math.min(s.metrics.bombCount, 1)),
  A("bunker_buster_ach", "Bunker Buster", "Land a bunker-class bomb (≥5% impact).", "bombs", "COMMON", 1, { points: 80 }, (s) => (s.metrics.bombCount >= 1 ? 1 : 0)),
  A("cruise_missile_ach", "Cruise Control", "Drop a cruise missile (≥12% impact).", "bombs", "BLESSED", 1, { points: 200, trail: "Smoke Trail" }, (s) => (s.metrics.bombCount >= 3 ? 1 : 0)),
  A("nuke_ach", "Survived a Nuke", "Be present for a nuke (≥25% impact).", "bombs", "ANOINTED", 1, { points: 700, frame: "Fallout Rim" }, (s) => s.metrics.nukeCount),
  A("atom_bomber", "Atom Bomber", "Detonate an atom bomb (≥50% impact).", "bombs", "GLORIFIED", 1, { points: 2500, skin: "Atom Warhead", trail: "Mushroom Wake" }, (s) => Math.max(0, s.metrics.nukeCount >= 2 ? 1 : 0)),
  A("carpet_bomber", "Carpet Bomber", "Drop 15 bombs.", "bombs", "ANOINTED", 15, { points: 1000 }, (s) => s.metrics.bombCount),
  A("shock_and_awe", "Shock & Awe", "Stack aggression score to 100.", "bombs", "BLESSED", 100, { points: 450 }, (s) => Math.round(s.traits.aggression)),
  A("diamond_halo", "Diamond Halo", "Hold through a −50% drawdown.", "conviction", "ANOINTED", 1, { points: 900, frame: "Diamond Halo" }, (s) => s.metrics.diamondHandsCount),
  A("believer_badge", "True Believer", "Average hold time ≥ 12 hours.", "conviction", "BLESSED", 12, { points: 350, trail: "Patience Gold" }, (s) => Math.floor(s.metrics.avgHoldHours)),
  A("round_tripper", "Round Tripper", "Go +2× then close at a loss.", "conviction", "COMMON", 1, { points: 60 }, (s) => s.ct.roundsTripped),
  A("iron_seat", "Iron Seat", "Hold any position for 48 hours continuous.", "conviction", "BLESSED", 48, { points: 500 }, (s) => Math.floor(s.metrics.openHoldHours || s.metrics.avgHoldHours)),
  A("unfumbled", "Unfumbled", "Realize a +$500 close.", "conviction", "ANOINTED", 500, { points: 800 }, (s) => Math.max(0, Math.floor(s.ct.biggestW))),
  A("bag_redemption", "Bag Redemption", "Hold a diamond drawdown and still bank a W.", "conviction", "GLORIFIED", 1, { points: 1500, skin: "Redeemed Hull" }, (s) => (s.metrics.diamondHandsCount >= 1 && s.ct.biggestW > 0 ? 1 : 0)),
  A("pad_ignition", "Pad Ignition", "Launch your first rocket.", "launcher", "COMMON", 1, { points: 200, frame: "Ignition Ring" }, (s) => s.metrics.launches),
  A("graduated_dev", "Blessed Dev", "Graduate a rocket you launched.", "launcher", "ANOINTED", 1, { points: 1200, trail: "Creator Wake" }, (s) => s.metrics.graduatedLaunches),
  A("serial_launcher", "Serial Launcher", "Launch 5 rockets.", "launcher", "BLESSED", 5, { points: 600 }, (s) => s.metrics.launches),
  A("kingmaker_ach", "Kingmaker", "Early-fuel 2 rockets into Angels+.", "launcher", "GLORIFIED", 2, { points: 2000, frame: "Kingmaker Crown" }, (s) => s.metrics.kingmakerCount),
  A("trench_warfare", "Trench Warfare", "Log 40 trades with avg hold under 8 minutes.", "trencher", "BLESSED", 40, { points: 400, trail: "Dirt Wake" }, (s) => s.metrics.avgHoldHours * 60 <= 8 ? s.metrics.tradeCount : Math.min(s.metrics.tradeCount, 20)),
  A("flip_artist", "Flip Artist", "Complete 25 quick flips (<15 min holds).", "trencher", "COMMON", 25, { points: 180 }, (s) => s.playstyle.quickFlips),
  A("sniper_nest", "Sniper Nest", "Land 10 snipes in the first 2 minutes.", "trencher", "ANOINTED", 10, { points: 700, frame: "Scope Rim" }, (s) => Math.round(s.metrics.sniperBuyFraction * s.metrics.buyCount)),
  A("degen_passport", "Degen Passport", "Trade 15 distinct rockets.", "trencher", "BLESSED", 15, { points: 350 }, (s) => s.metrics.distinctRockets),
  A("ape_awakening", "Ape Awakening", "Hit an Ape Score of 70+.", "trencher", "COMMON", 70, { points: 120 }, (s) => s.ct.apeScore),
  A("season_initiate", "Season Initiate", "Reach season rank Ascendant.", "seasonal", "COMMON", 1, { points: 100 }, (s) => ["ASCENDANT", "BLESSED", "ANOINTED", "GLORIFIED", "DIVINE"].includes(s.rank.tier) ? 1 : 0),
  A("season_blessed", "Season Blessed", "Reach season rank Blessed.", "seasonal", "BLESSED", 1, { points: 300, frame: "Season Blessed" }, (s) => ["BLESSED", "ANOINTED", "GLORIFIED", "DIVINE"].includes(s.rank.tier) ? 1 : 0),
  A("season_anointed", "Season Anointed", "Reach season rank Anointed.", "seasonal", "ANOINTED", 1, { points: 1000, skin: "Anointed Livery" }, (s) => ["ANOINTED", "GLORIFIED", "DIVINE"].includes(s.rank.tier) ? 1 : 0),
  A("top_percentile", "Top of the Choir", "Finish in the top 5% of the leaderboard.", "seasonal", "GLORIFIED", 5, { points: 3000, trail: "Choir Light" }, (s) => (s.leaderboardTopPct <= 5 ? 5 : Math.max(0, 10 - s.leaderboardTopPct))),
  A("rhalo_stacker", "rHALO Stacker", "Earn 10,000 season points.", "seasonal", "ANOINTED", 10000, { points: 500 }, (s) => s.points),
  A("pass_level_25", "Halfway to Heaven", "Reach season pass level 25.", "seasonal", "BLESSED", 25, { points: 400, frame: "Pass 25" }, (s) => Math.min(25, Math.floor(s.points / 1000))),
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
      const order: Record<string, number> = { DIVINE: 5, GLORIFIED: 4, ANOINTED: 3, BLESSED: 2, COMMON: 1 };
      return (order[b.rarity] ?? 0) - (order[a.rarity] ?? 0);
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
  first_blessing: { icon: "🚀", color: "#7ec8ff" },
  through_pearly_gates: { icon: "🚪", color: "#fff7df" },
  seventh_heaven: { icon: "☁️", color: "#ffffff" },
  narrow_gate: { icon: "⛩️", color: "#a8e0ff" },
  firmament_walker: { icon: "🌌", color: "#c9b6f2" },
  angel_altitude: { icon: "👼", color: "#ffe7a3" },
  seraphim_sight: { icon: "✨", color: "#fff7df" },
  tier_tourist: { icon: "🗺️", color: "#9fd0ff" },
  best_x_10: { icon: "📈", color: "#ffe7a3" },
  best_x_50: { icon: "🏆", color: "#ffd060" },
  crew_captain_ach: { icon: "👑", color: "#ffd060" },
  gate_keeper_ach: { icon: "🔑", color: "#d9c4ff" },
  choir_of_three: { icon: "🪽", color: "#a8e0ff" },
  full_congregation: { icon: "👥", color: "#c9b6f2" },
  co_fueler: { icon: "⛽", color: "#7ec8ff" },
  ascension_assist: { icon: "🕊️", color: "#ffe7a3" },
  first_grenade: { icon: "💣", color: "#ff8fab" },
  bunker_buster_ach: { icon: "🧨", color: "#ff7eb9" },
  cruise_missile_ach: { icon: "🚀", color: "#ff6b6b" },
  nuke_ach: { icon: "☢️", color: "#ff6b6b" },
  atom_bomber: { icon: "💥", color: "#ff4d6d" },
  carpet_bomber: { icon: "🌩️", color: "#ff8fab" },
  shock_and_awe: { icon: "⚡", color: "#ffb37e" },
  diamond_halo: { icon: "💎", color: "#9fd0ff" },
  believer_badge: { icon: "🙏", color: "#ffe7a3" },
  round_tripper: { icon: "🔄", color: "#c8cde0" },
  iron_seat: { icon: "⏳", color: "#ffe7a3" },
  unfumbled: { icon: "💰", color: "#7dffa0" },
  bag_redemption: { icon: "🎒", color: "#c9b6f2" },
  pad_ignition: { icon: "🕯️", color: "#ffd98a" },
  graduated_dev: { icon: "🎓", color: "#c9b6f2" },
  serial_launcher: { icon: "🛫", color: "#ffd060" },
  kingmaker_ach: { icon: "👑", color: "#ffd060" },
  trench_warfare: { icon: "⛏️", color: "#9ff3c8" },
  flip_artist: { icon: "🎴", color: "#7dffa0" },
  sniper_nest: { icon: "🎯", color: "#7dffa0" },
  degen_passport: { icon: "🛂", color: "#ff7eb9" },
  ape_awakening: { icon: "🦍", color: "#ffb37e" },
  season_initiate: { icon: "⭐", color: "#8cc8ff" },
  season_blessed: { icon: "🌟", color: "#ffe7a3" },
  season_anointed: { icon: "✦", color: "#c9b6f2" },
  top_percentile: { icon: "🏅", color: "#ffd060" },
  rhalo_stacker: { icon: "✨", color: "#fff7df" },
  pass_level_25: { icon: "📜", color: "#c9b6f2" },
};

export function rarityStyle(rarity: AchievementRarity) {
  return ACHIEVEMENT_RARITY[rarity];
}

export function achievementById(id: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

/** Pick up to n highest-rarity achievements from catalog ids. */
export function topAchievements(ids: string[], n = 6): AchievementDef[] {
  const order: AchievementRarity[] = ["DIVINE", "GLORIFIED", "ANOINTED", "BLESSED", "COMMON"];
  return ids
    .map((id) => achievementById(id))
    .filter((a): a is AchievementDef => !!a)
    .sort((a, b) => order.indexOf(a.rarity) - order.indexOf(b.rarity))
    .slice(0, n);
}

export function achievementDisplay(id: string): { icon: string; color: string } {
  return ACHIEVEMENT_DISPLAY[id] ?? { icon: "⭐", color: "#ffe7a3" };
}

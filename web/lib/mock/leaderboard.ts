/**
 * SAMPLE DATA — deterministic pilot ladder for /leaderboard.
 * Replace via LeaderboardAdapter when indexer is live.
 */
import { topAchievements } from "../achievements";
import { DEMO_SELF_ADDRESS, DEMO_POOL } from "../config";
import type {
  HeavenTierName,
  LeaderboardAdapter,
  LeaderboardQuery,
  LeaderboardResult,
  LeaderboardRow,
  LeaderboardSort,
} from "../leaderboard";
import type { IdentityId } from "../identity";

type Seed = Omit<LeaderboardRow, "rank" | "badges" | "pnlUsd" | "pctGain" | "volumeUsd" | "avgHoldHours" | "totalHoldHours" | "username"> & {
  pnl: { "24h": number; "7d": number; all: number };
  pct: { "24h": number; "7d": number; all: number };
  vol: { "24h": number; "7d": number; all: number };
  hold: { "24h": number; "7d": number; all: number };
};

const SEEDS: Seed[] = [
  {
    address: "0xA11ce00000000000000000000000000000Seraph",
    handle: "seraph.eth",
    country: "US",
    identity: "smart_money",
    mode: "pve",
    achievementIds: ["seraphim_sight", "angel_altitude", "best_x_10", "crew_captain_ach", "rhalo_stacker", "season_anointed", "iron_seat", "diamond_halo"],
    ladderTier: "SERAPHIM",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 12840, "7d": 48200, all: 212400 },
    pct: { "24h": 18.4, "7d": 64.2, all: 412.0 },
    vol: { "24h": 92000, "7d": 410000, all: 2_100_000 },
    hold: { "24h": 14.2, "7d": 18.5, all: 22.0 },
  },
  {
    address: "0xB0mb000000000000000000000000000000Nuker",
    handle: "atomfall",
    country: "KR",
    identity: "nuker",
    mode: "pvp",
    achievementIds: ["atom_bomber", "nuke_ach", "first_grenade", "trench_warfare", "sniper_nest", "rhalo_stacker", "first_blessing"],
    ladderTier: "HEAVENLY HOST",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 22100, "7d": 38500, all: 98000 },
    pct: { "24h": 42.0, "7d": 55.1, all: 188.0 },
    vol: { "24h": 310000, "7d": 980000, all: 4_400_000 },
    hold: { "24h": 0.08, "7d": 0.12, all: 0.15 },
  },
  {
    address: DEMO_SELF_ADDRESS,
    handle: "you.halo",
    country: "US",
    identity: "believer",
    mode: "pve",
    isSelf: true,
    achievementIds: ["believer_badge", "diamond_halo", "iron_seat", "first_blessing", "choir_of_three", "angel_altitude", "season_initiate"],
    ladderTier: "MORNING STARS",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 420, "7d": 3100, all: 18400 },
    pct: { "24h": 3.2, "7d": 12.8, all: 86.0 },
    vol: { "24h": 4800, "7d": 28000, all: 190000 },
    hold: { "24h": 16.0, "7d": 20.4, all: 28.0 },
  },
  {
    address: "0xTr3nch0000000000000000000000000000Flip",
    handle: "trenchkitty",
    country: "JP",
    identity: "trencher",
    mode: "pvp",
    achievementIds: ["trench_warfare", "sniper_nest", "first_grenade", "first_blessing", "rhalo_stacker", "season_initiate"],
    ladderTier: "FIRMAMENT",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 6100, "7d": 15400, all: 42000 },
    pct: { "24h": 9.1, "7d": 22.0, all: 71.5 },
    vol: { "24h": 180000, "7d": 720000, all: 3_100_000 },
    hold: { "24h": 0.05, "7d": 0.06, all: 0.07 },
  },
  {
    address: "0xWh4le00000000000000000000000000000Tank",
    handle: "deeppocket",
    country: "AE",
    identity: "whale",
    mode: "pve",
    achievementIds: ["rhalo_stacker", "angel_altitude", "best_x_10", "crew_captain_ach", "gate_keeper_ach", "graduated_dev", "pad_ignition"],
    ladderTier: "CHERUBIM",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 8900, "7d": 52000, all: 310000 },
    pct: { "24h": 4.5, "7d": 19.0, all: 95.0 },
    vol: { "24h": 450000, "7d": 1_800_000, all: 9_200_000 },
    hold: { "24h": 9.5, "7d": 11.0, all: 14.2 },
  },
  {
    address: "0xSn1pe0000000000000000000000000000Early",
    handle: "blockzero",
    country: "DE",
    identity: "sniper",
    mode: "pve",
    achievementIds: ["sniper_nest", "first_blessing", "best_x_10", "angel_altitude", "season_initiate", "choir_of_three"],
    ladderTier: "OUTER SPACE",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 3400, "7d": 11200, all: 56000 },
    pct: { "24h": 28.0, "7d": 41.0, all: 220.0 },
    vol: { "24h": 22000, "7d": 88000, all: 410000 },
    hold: { "24h": 2.1, "7d": 3.4, all: 4.0 },
  },
  {
    address: "0xB0mb2r000000000000000000000000000Dump",
    handle: "bunker.eth",
    country: "BR",
    identity: "bomber",
    mode: "pvp",
    achievementIds: ["nuke_ach", "first_grenade", "trench_warfare", "first_blessing", "sniper_nest", "rhalo_stacker"],
    ladderTier: "KÁRMÁN LINE",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": -2100, "7d": 8400, all: 27500 },
    pct: { "24h": -6.2, "7d": 15.5, all: 48.0 },
    vol: { "24h": 140000, "7d": 510000, all: 1_900_000 },
    hold: { "24h": 0.2, "7d": 0.35, all: 0.5 },
  },
  {
    address: "0xCr3w000000000000000000000000000Captain",
    handle: "winglead",
    country: "GB",
    identity: "crew_captain",
    mode: "pve",
    achievementIds: ["crew_captain_ach", "gate_keeper_ach", "choir_of_three", "believer_badge", "iron_seat", "angel_altitude", "season_initiate"],
    ladderTier: "THE MOON",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 1900, "7d": 9800, all: 71000 },
    pct: { "24h": 5.5, "7d": 17.2, all: 140.0 },
    vol: { "24h": 31000, "7d": 150000, all: 880000 },
    hold: { "24h": 11.0, "7d": 13.5, all: 19.0 },
  },
  {
    address: "0xD1am0000000000000000000000000000Hands",
    handle: "stillholding",
    country: "CA",
    identity: "diamond_hands",
    mode: "pve",
    achievementIds: ["diamond_halo", "believer_badge", "iron_seat", "first_blessing", "angel_altitude", "season_initiate"],
    ladderTier: "URANUS",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": -800, "7d": 2200, all: 33400 },
    pct: { "24h": -1.4, "7d": 6.1, all: 112.0 },
    vol: { "24h": 9000, "7d": 41000, all: 260000 },
    hold: { "24h": 48.0, "7d": 72.0, all: 96.0 },
  },
  {
    address: "0xKing000000000000000000000000000Maker1",
    handle: "kingmaker",
    country: "SG",
    identity: "kingmaker",
    mode: "pve",
    achievementIds: ["angel_altitude", "best_x_10", "gate_keeper_ach", "choir_of_three", "rhalo_stacker", "season_anointed", "seraphim_sight"],
    ladderTier: "LIMBO",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 7600, "7d": 29100, all: 155000 },
    pct: { "24h": 14.0, "7d": 38.0, all: 290.0 },
    vol: { "24h": 67000, "7d": 290000, all: 1_400_000 },
    hold: { "24h": 6.5, "7d": 8.0, all: 10.5 },
  },
  {
    address: "0xFarm0000000000000000000000000000Halo",
    handle: "rhalo.farmer",
    country: "NL",
    identity: "farmer",
    mode: "pve",
    achievementIds: ["season_initiate", "first_blessing", "choir_of_three", "iron_seat", "believer_badge", "pad_ignition"],
    ladderTier: "STRATOSPHERE",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 12, "7d": 40, all: 48 },
    pct: { "24h": 0.2, "7d": 0.8, all: 1.1 },
    vol: { "24h": 1200, "7d": 8000, all: 52000 },
    hold: { "24h": 20.0, "7d": 24.0, all: 30.0 },
  },
  {
    address: "0xLaunch00000000000000000000000000Pad",
    handle: "padlighter",
    country: "AU",
    identity: "launcher",
    mode: "pve",
    achievementIds: ["pad_ignition", "graduated_dev", "first_blessing", "crew_captain_ach", "angel_altitude", "gate_keeper_ach"],
    ladderTier: "GATES OF HEAVEN",
    rocketAddress: DEMO_POOL.address,
    rocketTicker: "AI",
    pnl: { "24h": 5100, "7d": 17800, all: 89000 },
    pct: { "24h": 11.2, "7d": 29.0, all: 175.0 },
    vol: { "24h": 44000, "7d": 190000, all: 990000 },
    hold: { "24h": 7.0, "7d": 9.2, all: 12.0 },
  },
];

function sortKey(sort: LeaderboardSort, row: LeaderboardRow): number {
  switch (sort) {
    case "pnl":
      return row.pnlUsd;
    case "pctGain":
      return row.pctGain;
    case "volume":
      return row.volumeUsd;
    case "holdTime":
      return row.totalHoldHours;
  }
}

export function usernameSlug(handle: string) {
  return handle.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20);
}
/** Sample pilot usernames (static export pre-renders /u/[username] for these). */
export const SAMPLE_USERNAMES: string[] = SEEDS.map((s) => usernameSlug(s.handle));

export function buildMockRows(query: LeaderboardQuery): LeaderboardRow[] {
  const w = query.window;
  const mapped: LeaderboardRow[] = SEEDS.map((s, i) => ({
    address: s.address,
    handle: s.handle,
    username: usernameSlug(s.handle),
    country: s.country,
    identity: s.identity as IdentityId,
    mode: s.mode,
    achievementIds: s.achievementIds,
    badges: topAchievements(s.achievementIds, 6),
    ladderTier: s.ladderTier as HeavenTierName,
    rocketAddress: s.rocketAddress,
    rocketTicker: s.rocketTicker,
    isSelf: s.isSelf,
    pnlUsd: s.pnl[w],
    pctGain: s.pct[w],
    volumeUsd: s.vol[w],
    avgHoldHours: s.hold[w],
    // Cumulative hold = avg hold × positions held in window (sample position counts).
    totalHoldHours: s.hold[w] * (w === "24h" ? 2 + (i % 3) : w === "7d" ? 6 + (i * 5) % 11 : 20 + (i * 7) % 31),
    rank: 0,
  }));

  mapped.sort((a, b) => sortKey(query.sort, b) - sortKey(query.sort, a));
  mapped.forEach((r, i) => {
    r.rank = i + 1;
  });
  return mapped;
}

export const mockLeaderboardAdapter: LeaderboardAdapter = {
  async getLeaderboard(query) {
    const rows = buildMockRows(query);
    const result: LeaderboardResult = {
      rows,
      window: query.window,
      sort: query.sort,
      source: "mock",
      updatedAt: Date.now(),
    };
    return result;
  },
};

/** Active adapter — swap to indexer client later. */
export const leaderboardAdapter: LeaderboardAdapter = mockLeaderboardAdapter;

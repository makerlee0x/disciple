/**
 * Leaderboard data adapter — mock now, indexer later.
 * Swap `getLeaderboard` implementation without changing the page.
 */
import type { IdentityId } from "./identity";
import type { AchievementDef } from "./achievements";
import { DEMO_POOL, TIERS } from "./config";

export type LeaderboardSort = "pnl" | "pctGain" | "volume" | "holdTime";
export type LeaderboardWindow = "24h" | "7d" | "all";

export type HeavenTierName = (typeof TIERS)[number]["name"];

export interface LeaderboardRow {
  rank: number;
  address: string;
  handle: string;
  /** ISO 3166-1 alpha-2 for flag emoji */
  country: string;
  identity: IdentityId;
  pnlUsd: number;
  pctGain: number;
  volumeUsd: number;
  avgHoldHours: number;
  /** PvP when bomber/nuker-heavy or dumps; else PvE */
  mode: "pve" | "pvp";
  achievementIds: string[];
  /** Top earned badges resolved for display */
  badges: AchievementDef[];
  /** Heaven ladder tier label (e.g. ANGELS, SERAPHIM) */
  ladderTier: HeavenTierName;
  /** Current rocket the play button opens */
  rocketAddress: string;
  rocketTicker: string;
  isSelf?: boolean;
}

export interface LeaderboardQuery {
  sort: LeaderboardSort;
  window: LeaderboardWindow;
}

export interface LeaderboardResult {
  rows: LeaderboardRow[];
  window: LeaderboardWindow;
  sort: LeaderboardSort;
  /** SAMPLE DATA until indexer is wired */
  source: "mock" | "indexer";
  updatedAt: number;
}

export interface LeaderboardAdapter {
  getLeaderboard(query: LeaderboardQuery): Promise<LeaderboardResult>;
}

export const DEFAULT_ROCKET = DEMO_POOL.address;

export function flagEmoji(cc: string): string {
  const code = cc.trim().toUpperCase();
  if (code.length !== 2) return "🏳️";
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + (code.charCodeAt(0) - 65),
    A + (code.charCodeAt(1) - 65),
  );
}

export function fmtHold(hours: number): string {
  if (hours < 1 / 60) return "<1m";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function fmtPct(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

export function fmtSignedUsd(v: number): string {
  const abs =
    Math.abs(v) >= 1e6
      ? `$${(Math.abs(v) / 1e6).toFixed(2)}M`
      : Math.abs(v) >= 1e3
        ? `$${(Math.abs(v) / 1e3).toFixed(1)}K`
        : `$${Math.abs(v).toFixed(0)}`;
  if (v > 0) return `+${abs}`;
  if (v < 0) return `−${abs}`;
  return abs;
}

/** Soft color for heaven ladder chips */
export function ladderColor(name: HeavenTierName): string {
  const map: Partial<Record<HeavenTierName, string>> = {
    "LAUNCH PAD": "#9aa6c0",
    LIMBO: "#8a9bb8",
    ASCENSION: "#7ec8ff",
    "NARROW GATE": "#a8e0ff",
    "PEARLY GATES": "#fff7df",
    FIRMAMENT: "#c9b6f2",
    ANGELS: "#ffe7a3",
    ARCHANGELS: "#ffd060",
    "HEAVENLY HOST": "#e8d4ff",
    "MORNING STARS": "#fff7df",
    VIRTUES: "#9fd0ff",
    DOMINIONS: "#c9b6f2",
    "THRONE ROOM": "#ffd060",
    CHERUBIM: "#ffe7a3",
    SERAPHIM: "#fff7df",
    AETHER: "#d9c4ff",
    EMPYREAN: "#fff7df",
    "SEVENTH HEAVEN": "#ffffff",
  };
  return map[name] ?? "#ffe7a3";
}

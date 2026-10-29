/**
 * Leaderboard data adapter. No per-pilot ranking source is wired yet, so production shows no rows (the page's
 * "No pilots yet" empty state); an indexer adapter slots in here without changing the page.
 * The sample pilots in lib/mock/leaderboard.ts load only in `next dev` with ?sample=1 (lib/devSample).
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
  /** Cumulative hold time across positions in the window (leaderboard "Hold" column). */
  totalHoldHours: number;
  /** Public profile slug (/u/[username]) */
  username: string;
  /** PvP when bomber/nuker-heavy or dumps; else PvE */
  mode: "pve" | "pvp";
  achievementIds: string[];
  /** Top earned badges resolved for display */
  badges: AchievementDef[];
  /** Heaven ladder tier label (e.g. MORNING STARS, SERAPHIM) */
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
  /** "mock" = dev-only sample pilots; "none" = no ranking source wired yet */
  source: "mock" | "indexer" | "none";
  updatedAt: number;
}

export interface LeaderboardAdapter {
  getLeaderboard(query: LeaderboardQuery): Promise<LeaderboardResult>;
}

export const DEFAULT_ROCKET = DEMO_POOL.address;

/** Production adapter until real per-pilot scores exist: no rows, never sample pilots. */
export const emptyLeaderboardAdapter: LeaderboardAdapter = {
  async getLeaderboard(q) {
    return { rows: [], window: q.window, sort: q.sort, source: "none", updatedAt: Date.now() };
  },
};

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
  // Brand v1: distinct-hue ladder retuned for Lunar (desaturated, all ≥7:1 on #0B0C0E). No gold.
  const map: Partial<Record<HeavenTierName, string>> = {
    "LAUNCH PAD": "#949CA8",
    OZONE: "#8E9EC2",
    STRATOSPHERE: "#85B0D6",
    "KÁRMÁN LINE": "#70BACD",
    "OUTER SPACE": "#67C1BB",
    FIRMAMENT: "#6EC4A4",
    "MORNING STARS": "#77C591",
    "HEAVENLY HOST": "#86BF7D",
    "THE MOON": "#9CC072",
    "URANUS": "#DE9A73",
    LIMBO: "#DD8B7E",
    "GATES OF HEAVEN": "#DA8B9F",
    "THRONE ROOM": "#D392B8",
    CHERUBIM: "#CEA1CE",
    SERAPHIM: "#C9A8DC",
    AETHER: "#BCABE3",
    EMPYREAN: "#B3B6E6",
    "SEVENTH HEAVEN": "#E8EAEE",
  };
  return map[name] ?? "#949CA8";
}

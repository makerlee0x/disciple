/**
 * Trading Duel seasons (maker 2026-11-16: "season ladder, win streak"). Pure, shared by server, client and tests.
 *
 * A season is one UTC calendar month. Season 1 is November 2026. Ranked duels earn season points (SP) on top of the
 * all-time rating: a win is +30, plus +5 for each win already in your streak (up to +25), a draw is +10, a loss is −15,
 * never below 0. SP climb you through leagues; everyone starts the next month at 0. Friendly and bot duels earn no SP.
 * The numbers are a starting point for maker to tune.
 */
export const SEASON_ONE = { y: 2026, m: 11 } as const; // month is 1-based

export const SP = { win: 30, streakStep: 5, streakMax: 25, draw: 10, loss: -15 } as const;

export const LEAGUES = [
  { id: "rookie", name: "Rookie", min: 0, color: "#D7D9E4" },
  { id: "bronze", name: "Bronze", min: 100, color: "#E0A070" },
  { id: "silver", name: "Silver", min: 250, color: "#C9D1DE" },
  { id: "gold", name: "Gold", min: 500, color: "#F2C14E" },
  { id: "platinum", name: "Platinum", min: 800, color: "#8FE3FF" },
  { id: "diamond", name: "Diamond", min: 1200, color: "#B7A6FF" },
  { id: "champion", name: "Champion", min: 1800, color: "#FF9CC4" },
] as const;
export type League = (typeof LEAGUES)[number];

export interface Season { id: string; n: number; startsAt: number; endsAt: number }

/** The season a moment falls in. Before Season 1 it reports Season 1. */
export function seasonAt(ms: number): Season {
  const d = new Date(ms);
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (y < SEASON_ONE.y || (y === SEASON_ONE.y && m < SEASON_ONE.m)) { y = SEASON_ONE.y; m = SEASON_ONE.m; }
  const n = (y - SEASON_ONE.y) * 12 + (m - SEASON_ONE.m) + 1;
  return { id: `${y}-${String(m).padStart(2, "0")}`, n, startsAt: Date.UTC(y, m - 1, 1), endsAt: Date.UTC(y, m, 1) };
}

/** SP change for one ranked result. `streakBefore` is the win streak going into this duel. */
export function spDelta(score: 0 | 0.5 | 1, streakBefore: number): number {
  if (score === 1) return SP.win + Math.min(SP.streakMax, Math.max(0, streakBefore) * SP.streakStep);
  return score === 0.5 ? SP.draw : SP.loss;
}
export const applySp = (pts: number, d: number) => Math.max(0, Math.round(pts + d));

export function leagueOf(pts: number): League {
  let l: League = LEAGUES[0];
  for (const x of LEAGUES) if (pts >= x.min) l = x;
  return l;
}
/** Progress to the next league, 0..1 (1 in Champion). */
export function leagueProgress(pts: number): { league: League; next: League | null; pct: number } {
  const league = leagueOf(pts), i = LEAGUES.indexOf(league), next = LEAGUES[i + 1] ?? null;
  return { league, next, pct: next ? Math.min(1, (pts - league.min) / (next.min - league.min)) : 1 };
}

/** Win streak milestones worth a callout on the result card (3, 5, 10, then every 5). */
export const isStreakMilestone = (streak: number) => streak === 3 || streak === 5 || (streak >= 10 && streak % 5 === 0);

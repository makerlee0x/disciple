/**
 * Trading Duel seasons (maker 2026-11-16: "season ladder, win streak"). Pure, shared by server, client and tests.
 *
 * A season is 12 weeks (maker 2026-11-18: same length as a prestige run on the XP track). Season 1 starts at launch
 * (SEASON_ONE_START). Ranked duels earn season points (SP) on top of the all-time rating: a win is +30, plus +5 for each
 * win already in your streak (up to +25), a draw is +10, a loss is −15, never below 0. SP climb you through leagues;
 * everyone starts the next season at 0. Friendly and bot duels earn no SP.
 * The numbers are a starting point for maker to tune.
 */
/** Ranked play is real money only (maker 2026-11-17). Until real-money duels are live (Nova), the online queue is unranked:
 *  no rating change, no season points, no Duels board. Win/loss record and win streak still count. A build with
 *  NEXT_PUBLIC_DUEL_RANKED=1 turns ranking on. */
export const DUEL_RANKED_LIVE: boolean = process.env.NEXT_PUBLIC_DUEL_RANKED === "1" || process.env.NEXT_PUBLIC_DUEL_RANKED === "true";

/** Season length: 12 weeks (84 days). */
export const SEASON_MS = 84 * 86_400_000;
/** Season 1 starts at launch, 00:00 UTC. Set NEXT_PUBLIC_SEASON_ONE_START (an ISO date, e.g. 2026-12-01) to the launch day;
 *  the default below is a placeholder until launch day is set. */
const SEASON_ONE_DEFAULT = "2026-12-01";
function seasonOneStart(): number {
  const t = Date.parse(`${process.env.NEXT_PUBLIC_SEASON_ONE_START || SEASON_ONE_DEFAULT}T00:00:00Z`);
  return Number.isFinite(t) ? t : Date.parse(`${SEASON_ONE_DEFAULT}T00:00:00Z`);
}
export const SEASON_ONE_START: number = seasonOneStart();

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

/** The season a moment falls in: 12-week blocks from SEASON_ONE_START. Before launch it reports Season 1 (nothing before
 *  its start counts, since every SP source reads its window from startsAt). */
export function seasonAt(ms: number): Season {
  const i = Math.max(0, Math.floor((ms - SEASON_ONE_START) / SEASON_MS));
  const startsAt = SEASON_ONE_START + i * SEASON_MS;
  return { id: `s${i + 1}`, n: i + 1, startsAt, endsAt: startsAt + SEASON_MS };
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

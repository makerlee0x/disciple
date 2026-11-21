/**
 * Weekly board (spectate + weekly leaderboard thread, 2026-11-21). The same season points table (lib/season/points) counted
 * over one UTC week, Monday 00:00 to Monday 00:00, so a new pilot has a fresh shot every Monday instead of chasing a
 * 12-week ladder. Pure, shared by server, client and tests.
 *
 *   rockets  the season rule (per $ banked, capped a UTC day), over this week's closes
 *   duel     an online duel (quick match, ranked or unranked; not friend codes, not bots, not guests): win +30, draw +10,
 *            a loss costs nothing. At most PAIR_CAP scoring duels per pair of pilots a week, so two wallets can't farm it.
 *   royale / climb  whatever season points the run paid (lib/server/seasonModes), the week they were paid
 *
 * Prizes are a proposal only (docs/proposals/weekly-prizes.md); nothing here pays anything.
 */
import { SP } from "@/lib/duel/season";

const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export interface Week { id: string; startsAt: number; endsAt: number }

/** The UTC week (Monday 00:00) a moment falls in. id = "w" + its Monday's date, e.g. w2026-11-16. */
export function weekAt(ms: number): Week {
  const day = Math.floor(ms / DAY_MS);
  // 1970-01-01 was a Thursday: (day + 3) % 7 is days since Monday
  const startsAt = (day - ((day % 7) + 7 + 3) % 7) * DAY_MS;
  return { id: `w${new Date(startsAt).toISOString().slice(0, 10)}`, startsAt, endsAt: startsAt + WEEK_MS };
}
export const lastWeekAt = (ms: number): Week => weekAt(weekAt(ms).startsAt - 1);

/** Weekly points for one online duel result (score 1 win, 0.5 draw, 0 loss). Never negative. */
export const WEEK_DUEL = { win: SP.win, draw: SP.draw } as const;
export const duelWeekPts = (score: 0 | 0.5 | 1) => (score === 1 ? WEEK_DUEL.win : score === 0.5 ? WEEK_DUEL.draw : 0);
/** scoring duels per pair of pilots per week */
export const PAIR_CAP = 3;
/** only real wallets go on the board (the /duel demo's guests don't) */
export const isWallet = (pid: string) => /^0x[0-9a-f]{40}$/.test(pid);

/** "3d 4h" / "5h 12m" / "8m" until `to` */
export function resetIn(to: number, now: number): string {
  const m = Math.max(0, Math.floor((to - now) / 60_000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** Proposed weekly prizes (docs/proposals/weekly-prizes.md): off-chain crates from the collection, by final place.
 *  Paid only when the server sets WEEKLY_PRIZES=1 (app/api/cron/weekly-prizes); off by default. */
export const WEEK_PRIZES: readonly { from: number; to: number; crate: "legendary" | "epic" | "rare" }[] = [
  { from: 1, to: 1, crate: "legendary" },
  { from: 2, to: 3, crate: "epic" },
  { from: 4, to: 10, crate: "rare" },
];
export const prizeFor = (rank: number) => WEEK_PRIZES.find((p) => rank >= p.from && rank <= p.to)?.crate ?? null;

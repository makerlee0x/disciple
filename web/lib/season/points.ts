/**
 * Overall rank (maker 2026-11-18: "top ranked in duel, royale, climb, top ranked overall"). Every mode pays season points
 * (SP) into one 12-week ladder, the same seasons and leagues as the duel ladder (lib/duel/season). Overall = SP from every
 * mode added up. The weights are this table; it's a starting point for maker to tune. Ranked is real money only, so
 * Duel / Royale / Climb pay SP only once their real-money runs are live. Pure, shared by server, client and tests.
 */
import { SP } from "@/lib/duel/season";

export type RankMode = "rockets" | "duel" | "royale" | "climb";
export const RANK_MODES: readonly RankMode[] = ["rockets", "duel", "royale", "climb"];

export const MODE_SP = {
  /** a ranked duel: win +30 (+5 a streak win, up to +25), draw +10, loss -15 (lib/duel/season SP) */
  duel: SP,
  /** a ranked royale by final place */
  royale: { first: 50, top3: 25, top10: 10 },
  /** a climb level, the first time it's cleared this season: perLevel × the level (maker 2026-11-18: raised from 20, so
   *  clearing all 5 levels is 1,500 SP a season, about a third of what Rockets can pay in 12 weeks) */
  climb: { perLevel: 100 },
  /** rockets: per $ banked, capped a day (UTC) so one big bag can't buy the ladder */
  rockets: { perUsd: 10, dayCap: 50 },
} as const;

export function royaleSp(place: number): number {
  const r = MODE_SP.royale;
  return place === 1 ? r.first : place >= 2 && place <= 3 ? r.top3 : place >= 4 && place <= 10 ? r.top10 : 0;
}
export const climbSp = (level: number) => Math.max(0, Math.floor(level)) * MODE_SP.climb.perLevel;
/** one UTC day's realized rocket PnL → SP (red days pay nothing; there's no SP loss in Rockets) */
export const rocketsDaySp = (pnlUsd: number) => Math.min(MODE_SP.rockets.dayCap, Math.max(0, Math.floor(pnlUsd / MODE_SP.rockets.perUsd)));

export type ModeSp = Partial<Record<RankMode, number>>;
export const totalSp = (m: ModeSp) => RANK_MODES.reduce((s, k) => s + (m[k] ?? 0), 0);

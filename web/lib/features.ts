/**
 * Feature switches for UI that exists in code but isn't live yet. Flip a constant (or set the NEXT_PUBLIC_ override at
 * build time) to bring the feature back; nothing else needs to change.
 */

/**
 * Profile Loot tab (cosmetic parts from achievements). Hidden until loot is a real feature (lee, 2026-10-24).
 * Off: the profile shows Rockets · Achievements · Activity, ?tab=loot / ?slot= deep links fall back to Rockets, and no
 * loot count / reward line / link shows anywhere on the profile. On: Rockets · Loot · Achievements · Activity.
 * Override: NEXT_PUBLIC_FEATURE_LOOT=1 (build-time; not set anywhere today).
 */
export const LOOT_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_LOOT === "1" || process.env.NEXT_PUBLIC_FEATURE_LOOT === "true";

/**
 * Real player progress (titles, season tier, level, header stats). Off until the indexer serves real per-wallet
 * achievement / season data (lee, 2026-10-24: "Hide it"). Today those numbers come from lib/mock/sample-trades, so
 * while this is off:
 *  - the profile header shows no stats, no season tier (ANOINTED…) and no LVL, and the title is always "Normie";
 *  - no title counts as earned (lib/titles earnedTitlesFor → []), so the picker shows its empty state and
 *    /api/profile/meta rejects every title pick ("You haven't earned that title yet.").
 * Turn on only after lib/titles profileStatsFor() returns real stats. Override: NEXT_PUBLIC_FEATURE_REAL_PROGRESS=1
 * (build-time; not set anywhere today).
 */
export const REAL_PROGRESS_ENABLED: boolean =
  process.env.NEXT_PUBLIC_FEATURE_REAL_PROGRESS === "1" || process.env.NEXT_PUBLIC_FEATURE_REAL_PROGRESS === "true";

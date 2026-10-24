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

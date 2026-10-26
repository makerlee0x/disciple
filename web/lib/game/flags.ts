import { ACTIVE_CHAIN } from "@/lib/chains";

/**
 * GAME feature flags for achievements / profile.
 * - SEASONS_UI: all season UI (season names, timers, season rank badges, "Season 1" copy) stays hidden until lee starts
 *   Season 1 by hand (lee, Oct 26). Off by default; only NEXT_PUBLIC_SEASONS_UI=1 turns it on. Nothing auto-starts a season.
 * - ACH_BETA: achievements on testnet are a beta — they reset at mainnet; nothing is migrated or carried over (lee, Oct 26).
 */
export const SEASONS_UI = process.env.NEXT_PUBLIC_SEASONS_UI === "1";
export const ACH_BETA = Boolean((ACTIVE_CHAIN as { testnet?: boolean }).testnet);

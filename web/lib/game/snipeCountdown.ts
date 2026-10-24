/**
 * SNIPER TAX countdown chip (flight HUD): the GAME-side wiring shared by components/flight/SnipeChip.tsx,
 * SnipeCountdown.tsx (live), components/sim/SimMode.tsx (SIMULATOR) and scripts/test-snipe-countdown.mjs. No DOM / React.
 *
 * All math + the chip text come from SITE's lib/snipe.ts (snipeState / snipeParamsFor / snipeFeeBpsAt / formatSnipeChip →
 * formatSnipePct), so the HUD chip reads exactly like SITE's BOOST panel. Steep coins: per-second table, 0 from 7s
 * ("ANTI-SNIPE 0:07 · 99%", "0:06 · 25%", "0:05 · 3%", "0:04 · 1%", "0:03 · 0.3%", "0:02 · 0.1%", "0:01 · 0.03%", then hidden);
 * never "0%" while a tax applies. Old v4 coins keep their linear 77.7% / 7 s schedule. This file only gates it.
 */
import { formatSnipeChip, type SnipeState } from "../snipe";

/** Gate for the whole chip (same pattern as SHOW_EXIT_NOTES): flip to false to hide it everywhere. */
export const SHOW_SNIPE_COUNTDOWN = true;
/** window event with the current chip state (detail: SnipeState) so the engine / other overlays can follow it; fired on change */
export const SNIPE_STATE_EVENT = "disciple:snipestate";
/** live chip: local countdown tick and snapshot re-read while the tax is active (the % steps every second, 0 from 7s) */
export const SNIPE_TICK_MS = 250;
export const SNIPE_POLL_MS = 250;
/** SIMULATOR launch epoch (s): sim time starts at 0 but snipeState treats launchTs ≤ 0 as "unknown" → off */
export const SIM_LAUNCH_TS = 1;

/** chip text, or null when the chip must be hidden (flag off / !active) */
export function snipeChipText(s: SnipeState | null | undefined, show: boolean = SHOW_SNIPE_COUNTDOWN): string | null {
  if (!show || !s || !s.active) return null;
  return formatSnipeChip(s);
}

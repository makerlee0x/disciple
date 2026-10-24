/**
 * SNIPER TAX countdown chip (flight HUD): the GAME-side wiring shared by components/flight/SnipeChip.tsx,
 * SnipeCountdown.tsx (live), components/sim/SimMode.tsx (SIMULATOR) and scripts/test-snipe-countdown.mjs. No DOM / React.
 *
 * All math + the chip text come from SITE's lib/snipe.ts (snipeState / snipeParamsFor / formatSnipeChip), so the HUD chip
 * reads exactly like SITE's BOOST panel ("ANTI-SNIPE 0:48 · 62%"). This file only gates it.
 */
import { formatSnipeChip, type SnipeState } from "../snipe";

/** Gate for the whole chip (same pattern as SHOW_EXIT_NOTES): flip to false to hide it everywhere. */
export const SHOW_SNIPE_COUNTDOWN = true;
/** window event with the current chip state (detail: SnipeState) so the engine / other overlays can follow it; fired on change */
export const SNIPE_STATE_EVENT = "disciple:snipestate";
/** SIMULATOR launch epoch (s): sim time starts at 0 but snipeState treats launchTs ≤ 0 as "unknown" → off */
export const SIM_LAUNCH_TS = 1;

/** chip text, or null when the chip must be hidden (flag off / !active) */
export function snipeChipText(s: SnipeState | null | undefined, show: boolean = SHOW_SNIPE_COUNTDOWN): string | null {
  if (!show || !s || !s.active) return null;
  return formatSnipeChip(s);
}

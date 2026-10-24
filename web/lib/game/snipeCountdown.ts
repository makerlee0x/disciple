/**
 * SNIPER TAX countdown chip (flight HUD): pure bits shared by components/flight/SnipeChip.tsx, SnipeCountdown.tsx (live),
 * components/sim/SimMode.tsx (SIMULATOR) and scripts/test-snipe-countdown.mjs. No DOM / React imports.
 *
 * State comes from lib/snipe.ts snipeState() (SITE-owned; a local stub until SITE's lands) — this file only gates + formats.
 */
import { formatSnipeClock, type SnipeState } from "../snipe";

/** Gate for the whole chip (same pattern as SHOW_EXIT_NOTES): flip to false to hide it everywhere. */
export const SHOW_SNIPE_COUNTDOWN = true;
/** i18n key of the chip text (lib/game/i18n.ts) — the one place to swap copy: "ANTI-SNIPE {clock} · {pct}%" */
export const SNIPE_CHIP_KEY = "snipe.chip" as const;
/** window event with the current chip state (detail: SnipeState) so the engine / other overlays can follow it; fired on change */
export const SNIPE_STATE_EVENT = "disciple:snipestate";

/** whole-number % (rounded up so a live fee never reads 0% while it still applies) */
export const snipePctLabel = (feePct: number) => Math.max(0, Math.ceil(feePct - 1e-9));

/** i18n vars for the chip, or null when it must be hidden (flag off / tax over) */
export function snipeChipVars(s: SnipeState | null | undefined, show: boolean = SHOW_SNIPE_COUNTDOWN): { clock: string; pct: number } | null {
  if (!show || !s || !s.active || s.secondsLeft <= 0 || s.feePct <= 0) return null;
  return { clock: formatSnipeClock(s.secondsLeft), pct: snipePctLabel(s.feePct) };
}

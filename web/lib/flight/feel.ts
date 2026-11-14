/**
 * Phone flight feel (maker 2026-11-14 "do them all"): pure rules for full-screen flying (components/flight/FlyCalm) and tilt
 * steering (components/flight/TiltSteer). Tested in scripts/test-native.mts.
 */
export const CALM_MS = 3500;
/** should the HUD rest now? */
export function calmNow(o: { on: boolean; phone: boolean; sheetOpen: boolean; dialog: boolean; sinceWake: number }): boolean {
  return o.on && o.phone && !o.sheetOpen && !o.dialog && o.sinceWake >= CALM_MS;
}

export const TILT_FULL_DEG = 24;   // this much tilt = the edge of the sky
export const TILT_DEAD_DEG = 3;    // a hand's wobble does nothing
/** device gamma (degrees, + = right edge down) → steering −1…1 */
export function tiltToX(gamma: number): number {
  if (!Number.isFinite(gamma)) return 0;
  const a = Math.abs(gamma);
  if (a <= TILT_DEAD_DEG) return 0;
  return Math.sign(gamma) * Math.min(1, (a - TILT_DEAD_DEG) / (TILT_FULL_DEG - TILT_DEAD_DEG));
}

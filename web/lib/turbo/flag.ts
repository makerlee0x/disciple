/**
 * TURBO visibility gate. ON for everyone since 2026-11-16 (maker: "turn turbo on. it can be on now"): the Turbo tab and
 * the Duel / Royale lobby cards show on every device. The early-access password on /turbo (TurboGate) is separate and
 * unchanged. A build with NEXT_PUBLIC_TURBO=0 hides it again.
 *
 * Before that it was on only when ANY of these was true:
 *  0. Inside the DISCIPLE iPhone app (maker 2026-11-14: "Turbo 1v1 duel is our viral game, we want it on mobile"). The app
 *     only ever gets practice duels (lib/turbo realTurboAllowed), and /turbo keeps its pre-launch password (TurboGate).
 *  1. Build-time NEXT_PUBLIC_TURBO=1 (not set anywhere today; optional for a preview build).
 *  2. Client-side localStorage "disciple.turbo.enabled.v1" === "1". Visiting any page that calls
 *     `syncTurboFlagFromUrl()` (or `isTurboEnabled()`) with `?turbo=1` sets it; `?turbo=0` clears it.
 *
 * Server-side (no window) only rule 1 applies, so call isTurboEnabled() from an effect in client components to avoid a
 * hydration mismatch, and render notFound()/nothing until it says true.
 */

import { isNativeApp } from "../native";

export const TURBO_FLAG_KEY = "disciple.turbo.enabled.v1";

/** The build's own setting: the same on the server and the first client render, so it can seed state without a mismatch. */
export function turboEnvOn(): boolean { return envOn(); }
function envOn(): boolean {
  const v = process.env.NEXT_PUBLIC_TURBO;
  return v !== "0" && v !== "false";   // on unless a build turns it off
}

/** Reads ?turbo=1 / ?turbo=0 from the current URL and persists it. Returns the stored value. No-op on the server. */
export function syncTurboFlagFromUrl(search?: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const qs = new URLSearchParams(search ?? window.location.search), q = qs.get("turbo");
    if (q === "1" || qs.get("sample") === "1") window.localStorage.setItem(TURBO_FLAG_KEY, "1");
    else if (q === "0") window.localStorage.removeItem(TURBO_FLAG_KEY);
    return window.localStorage.getItem(TURBO_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function isTurboEnabled(): boolean {
  if (envOn() || isNativeApp()) return true;
  return syncTurboFlagFromUrl();
}

/** Play sample link (/turbo?sample=1, for Nova and play-testers): also turns Turbo on, and on a device with no stand-in
 *  fuel the screen tops it up to SAMPLE_FUEL_USD once so the first run is one tap. Only ever with the stand-in adapter. */
export const SAMPLE_FUEL_USD = 100;
export const SAMPLE_GIVEN_KEY = "disciple.turbo.sample.v1";
export function isSampleLink(search?: string): boolean {
  if (typeof window === "undefined") return false;
  try { return new URLSearchParams(search ?? window.location.search).get("sample") === "1"; } catch { return false; }
}

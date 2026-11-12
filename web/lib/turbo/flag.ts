/**
 * TURBO visibility gate. Hidden everywhere by default (prod included) with no env or Vercel changes needed.
 *
 * On when ANY of these is true:
 *  1. Build-time NEXT_PUBLIC_TURBO=1 (not set anywhere today; optional for a preview build).
 *  2. Client-side localStorage "disciple.turbo.enabled.v1" === "1". Visiting any page that calls
 *     `syncTurboFlagFromUrl()` (or `isTurboEnabled()`) with `?turbo=1` sets it; `?turbo=0` clears it.
 *
 * Server-side (no window) only rule 1 applies, so call isTurboEnabled() from an effect in client components to avoid a
 * hydration mismatch, and render notFound()/nothing until it says true.
 */

export const TURBO_FLAG_KEY = "disciple.turbo.enabled.v1";

function envOn(): boolean {
  const v = process.env.NEXT_PUBLIC_TURBO;
  return v === "1" || v === "true";
}

/** Reads ?turbo=1 / ?turbo=0 from the current URL and persists it. Returns the stored value. No-op on the server. */
export function syncTurboFlagFromUrl(search?: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(search ?? window.location.search).get("turbo");
    if (q === "1") window.localStorage.setItem(TURBO_FLAG_KEY, "1");
    else if (q === "0") window.localStorage.removeItem(TURBO_FLAG_KEY);
    return window.localStorage.getItem(TURBO_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function isTurboEnabled(): boolean {
  if (envOn()) return true;
  return syncTurboFlagFromUrl();
}

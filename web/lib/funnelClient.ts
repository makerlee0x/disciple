/**
 * Client side of the funnel counter (see lib/funnel.ts). trackFunnel(step) sends a step at most once per browser and
 * never throws: storage, network or server errors are swallowed, so nothing a player does can break because of it.
 * Nothing personal is sent: the body is just { step }.
 */
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import { type FunnelStep, nextUtcDay, utcDay } from "@/lib/funnel";

const SENT = (s: FunnelStep) => `disciple:fun:${s}`;
const LAND_DAY = "disciple:fun:landday";

function sentAlready(step: FunnelStep): boolean {
  try { return !!localStorage.getItem(SENT(step)); } catch { return true; } // no storage ⇒ can't dedupe ⇒ don't count
}

export function trackFunnel(step: FunnelStep): void {
  try {
    if (typeof window === "undefined" || IS_STATIC_PREVIEW || sentAlready(step)) return;
    localStorage.setItem(SENT(step), String(Date.now()));
    if (step === "land") localStorage.setItem(LAND_DAY, utcDay(Date.now()));
    const body = JSON.stringify({ step });
    const url = withBase("/api/funnel");
    if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch { /* silent by design */ }
}

/** return_d1: this browser landed yesterday (UTC) and is back today. */
export function maybeTrackReturn(nowMs = Date.now()): void {
  try {
    const land = localStorage.getItem(LAND_DAY);
    if (land && nextUtcDay(land) === utcDay(nowMs)) trackFunnel("return_d1");
  } catch { /* silent */ }
}

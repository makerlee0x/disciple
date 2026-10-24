/**
 * EXIT CONFIRM guard (flight page): pure decisions shared by components/flight/ExitConfirm.tsx and scripts/test-exit-confirm.mjs.
 * No DOM / React imports so the offline test can load it as-is.
 *
 * What is guarded while a flight is active:
 *   - the exit ✕ (#exitX) and every other same-tab link that leaves the flight route (rail, logo, Dashboard, …)
 *   - the browser Back button (one same-URL guard history entry; Back pops it and opens the dialog)
 *   - real tab close / reload / typed URL: the browser's generic beforeunload prompt only (no custom copy is possible)
 * Never guarded: keys. The dialog adds no hotkey; while it is closed it has no key listener at all (trading hotkeys untouched).
 */

/** history.state marker for the guard entry pushed on the flight page */
export const GUARD_KEY = "__discipleExitGuard";
/** window event any surface can dispatch to ask "leave?" (detail: { href }) — e.g. a future ESC-menu Leave row */
export const EXIT_REQUEST_EVENT = "disciple:exit-request";
/** opt a link out of the guard: <a data-no-exit-confirm> */
export const OPT_OUT_ATTR = "data-no-exit-confirm";

export type ClickLike = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean };
export type AnchorLike = { href: string; target?: string | null; download?: boolean; optOut?: boolean };

/** true when navigating from `from` to `to` (absolute URLs) leaves the current flight page */
export function leavesFlight(from: string, to: string): boolean {
  let a: URL, b: URL;
  try { a = new URL(from); b = new URL(to); } catch { return false; }
  if (!/^https?:$/.test(b.protocol)) return false;   // mailto:, javascript:, blob: … are not a page change
  if (a.origin !== b.origin) return true;
  return a.pathname.replace(/\/+$/, "") !== b.pathname.replace(/\/+$/, "");   // same path (query / hash change) stays in the flight
}

/** the href to confirm for this click, or null to let the browser / Next handle it untouched */
export function interceptClick(ev: ClickLike, a: AnchorLike | null, current: string): string | null {
  if (!a || !a.href || a.optOut || a.download) return null;
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;   // new tab / window: the flight keeps running here
  if (a.target && a.target !== "_self") return null;
  return leavesFlight(current, a.href) ? a.href : null;
}

/** popstate decision: the guard entry was popped (Back) while still on the flight route → ask */
export function backNeedsConfirm(stateAfterPop: unknown, current: string, flightHref: string): boolean {
  const s = stateAfterPop as Record<string, unknown> | null;
  if (s && s[GUARD_KEY]) return false;   // Forward onto the guard entry again
  return !leavesFlight(flightHref, current);
}

/** state for the guard entry: keep Next's own fields (__NA / tree) so its patched pushState passes it straight through */
export function guardState(state: unknown): Record<string, unknown> {
  return { ...((state && typeof state === "object") ? state as Record<string, unknown> : {}), [GUARD_KEY]: 1 };
}

/** focus order inside the dialog: Stay first (default), Leave second; Tab / Shift+Tab wrap between them */
export function nextFocus(i: number, shift: boolean, n = 2): number { return ((shift ? i - 1 : i + 1) % n + n) % n; }

/** pending on-chain trades (live TradeBridge): window.__disciplePendingTrades = {buy, sell} in-flight counts, and this event fires on each change */
/** BRAND's secondary lines (exitc.note.*) are built but OFF until lee OKs them: flip to true to show them */
export const SHOW_EXIT_NOTES = false;
export const TRADE_PENDING_EVENT = "disciple:tradepending";
export type PendingTrades = { buy: number; sell: number };
export type ExitMode = "live" | "sim";
/** the dialog's smaller secondary lines (i18n keys): sim → practice line; live → coins line + one per pending side */
export function secondaryKeys(mode: ExitMode, pending?: Partial<PendingTrades> | null, show: boolean = SHOW_EXIT_NOTES): ("exitc.note.live" | "exitc.note.sim" | "exitc.note.boost" | "exitc.note.dump")[] {
  if (!show) return [];
  if (mode === "sim") return ["exitc.note.sim"];
  const out: ("exitc.note.live" | "exitc.note.boost" | "exitc.note.dump")[] = ["exitc.note.live"];
  if ((pending?.buy ?? 0) > 0) out.push("exitc.note.boost");
  if ((pending?.sell ?? 0) > 0) out.push("exitc.note.dump");
  return out;
}

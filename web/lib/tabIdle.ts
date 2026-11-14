/**
 * Background-tab check for polling loops (speed pass 2026-11-14). A tab that has been hidden for a while stops its chain
 * and API polls (block number + getLogs every 1.5 s per open flight, balances, cash, coin rules, price-impact quotes),
 * and each loop polls once when the tab comes back. A short switch away (under LONG_HIDDEN_MS) changes nothing.
 * No imports, safe on the server (always "visible" there).
 */
export const LONG_HIDDEN_MS = 60_000;
let hiddenAt = 0;
if (typeof document !== "undefined") {
  const f = () => { hiddenAt = document.hidden ? hiddenAt || Date.now() : 0; };
  f(); document.addEventListener("visibilitychange", f);
}
/** the tab has been in the background for at least `ms` */
export function longHidden(ms = LONG_HIDDEN_MS): boolean { return hiddenAt > 0 && Date.now() - hiddenAt >= ms; }
/** run `f` each time the tab becomes visible again; returns the unsubscribe */
export function onTabVisible(f: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const h = () => { if (!document.hidden) f(); };
  document.addEventListener("visibilitychange", h);
  return () => document.removeEventListener("visibilitychange", h);
}

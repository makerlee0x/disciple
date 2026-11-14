/**
 * Real Turbo fuel as Cash sees it (Add cash board 1: "Ready to spend" + "In Turbo fuel" under one total). Turbo's screen
 * publishes its fuel here ONLY for a real (Nova) adapter: practice fuel is pretend money and never counts as cash.
 * The last real amount is kept on this device so Cash still shows it after you leave Turbo with fuel kept there.
 * `toCash` is the adapter's move-back while Turbo is loaded; without it Cash's "Move to cash" opens Turbo.
 */
export type CashFuel = { usd: number; toCash?: (usd: number) => Promise<unknown> } | null;
export const CASH_FUEL_KEY = "disciple.turbo.cashfuel.v1";

const subs = new Set<(f: CashFuel) => void>();
const ls = () => { try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; } };
function readSaved(): CashFuel {
  try { const v = Number(JSON.parse(ls()?.getItem(CASH_FUEL_KEY) ?? "null")?.usd); return Number.isFinite(v) && v >= 0.01 ? { usd: v } : null; } catch { return null; }
}
let cur: CashFuel | undefined;

export function setCashFuel(f: CashFuel): void {
  cur = f && f.usd >= 0.01 ? f : null;
  try { if (cur) ls()?.setItem(CASH_FUEL_KEY, JSON.stringify({ usd: cur.usd })); else ls()?.removeItem(CASH_FUEL_KEY); } catch { /* ignore */ }
  subs.forEach((cb) => cb(cur ?? null));
}
export function cashFuel(): CashFuel { if (cur === undefined) cur = readSaved(); return cur; }
export function onCashFuel(cb: (f: CashFuel) => void): () => void { subs.add(cb); cb(cashFuel()); return () => { subs.delete(cb); }; }
// dev only (screenshots): window.__cashFuelDev(10) shows the "In Turbo fuel" line
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") (window as unknown as { __cashFuelDev?: (usd: number) => void }).__cashFuelDev = (usd) => setCashFuel({ usd });

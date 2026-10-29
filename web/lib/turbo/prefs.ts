/**
 * TURBO player prefs (GAME): leverage presets (editable), bet chips, selections, TP/SL toggle, mute and the
 * one-time 1000× heads-up flag. One localStorage key, sanitized on load. Pure helpers take a Storage-like object so
 * scripts/test-turbo-ui.mjs can test persistence without a browser.
 */
export const TURBO_PREFS_KEY = "disciple.turbo.prefs.v1";
export const DEFAULT_LEVERAGE = [100, 250, 500, 1000];
export const DEFAULT_BETS = [10, 25, 50, 100];
export const MIN_LEV = 2, MAX_LEV = 1000;
export const HEADS_UP_LEV = 1000;

export interface TurboPrefs {
  v: 1;
  lev: number[];       // 4 leverage presets (×)
  levSel: number;      // selected preset index (default 0 = 100×)
  bets: number[];      // 4 bet chips ($)
  betSel: number;
  market: "BTC" | "ETH";
  tpsl: boolean;       // TP/SL controls shown (off by default)
  muted: boolean;      // SUPERNOVA + beeps (loud by default)
  seen1000: boolean;   // the one-time 1000× heads-up was acknowledged
}
export const DEFAULT_PREFS: TurboPrefs = { v: 1, lev: DEFAULT_LEVERAGE, levSel: 0, bets: DEFAULT_BETS, betSel: 0, market: "BTC", tpsl: false, muted: false, seen1000: false };

type StoreLike = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export const clampLev = (v: unknown) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(MIN_LEV, Math.min(MAX_LEV, n)) : NaN; };
const clampBet = (v: unknown) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n > 0 ? Math.min(100_000, n) : NaN; };
const idx = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 4 ? (v as number) : d);
const list = (x: unknown, d: number[], f: (v: unknown) => number) => (Array.isArray(x) && x.length === 4 ? x.map((v, i) => { const n = f(v); return Number.isNaN(n) ? d[i] : n; }) : d.slice());

export function sanitizePrefs(x: unknown): TurboPrefs {
  const o = (x && typeof x === "object" ? x : {}) as Partial<TurboPrefs>;
  return {
    v: 1,
    lev: list(o.lev, DEFAULT_LEVERAGE, clampLev),
    levSel: idx(o.levSel, 0),
    bets: list(o.bets, DEFAULT_BETS, clampBet),
    betSel: idx(o.betSel, 0),
    market: o.market === "ETH" ? "ETH" : "BTC",
    tpsl: o.tpsl === true,
    muted: o.muted === true,
    seen1000: o.seen1000 === true,
  };
}
export function loadPrefs(store: StoreLike | null | undefined): TurboPrefs {
  try { const s = store?.getItem(TURBO_PREFS_KEY); return sanitizePrefs(s ? JSON.parse(s) : null); } catch { return sanitizePrefs(null); }
}
export function savePrefs(store: StoreLike | null | undefined, p: TurboPrefs) {
  try { store?.setItem(TURBO_PREFS_KEY, JSON.stringify(sanitizePrefs(p))); } catch { /* private mode / quota */ }
}
/** Edit one leverage preset (clamped 1..1000). Returns the new prefs (unchanged on bad input). */
export function setLevPreset(p: TurboPrefs, i: number, v: unknown): TurboPrefs {
  const n = clampLev(v); if (Number.isNaN(n) || i < 0 || i > 3) return p;
  const lev = p.lev.slice(); lev[i] = n; return { ...p, lev };
}
export function setBetPreset(p: TurboPrefs, i: number, v: unknown): TurboPrefs {
  const n = clampBet(v); if (Number.isNaN(n) || i < 0 || i > 3) return p;
  const bets = p.bets.slice(); bets[i] = n; return { ...p, bets };
}
/** Should picking this leverage show the one-time heads-up first? */
export function needsHeadsUp(p: TurboPrefs, lev: number) { return lev >= HEADS_UP_LEV && !p.seen1000; }

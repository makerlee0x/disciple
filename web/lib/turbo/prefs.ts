/** Turbo ticket choices (fuel chip, leverage chip, custom values), saved on this device only. Never touches game cash. */
import type { Market } from "./types";

export const TURBO_PREFS_KEY = "disciple.turbo.prefs.v1";
/** Four dollar fuel chips, like today's buy bar ($10 is today's default buy). */
export const FUEL_PRESETS = [10, 25, 50, 100] as const;
/** Lee, Nov 12 2026: 100×, 250×, 500×, 1000× (1000× is Nova's synthetic on top of Hyperliquid). Default 100×. */
export const LEVERAGE_PRESETS = [100, 250, 500, 1000] as const;
export const CLOSE_PCTS = [25, 50, 100] as const;

export interface TurboPrefs {
  market: Market;
  fuelIdx: number;          // -1 = custom
  fuelCustom: number;       // $
  levIdx: number;           // -1 = custom
  levCustom: number;        // ×
}

export const DEFAULT_PREFS: TurboPrefs = { market: "BTC", fuelIdx: 0, fuelCustom: 0, levIdx: 0, levCustom: 0 };

export function loadPrefs(storage?: Storage | null): TurboPrefs {
  try {
    const s = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    const raw = s?.getItem(TURBO_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const j = JSON.parse(raw) as Partial<TurboPrefs>;
    const idx = (v: unknown, n: number) => (typeof v === "number" && v >= -1 && v < n ? Math.trunc(v) : 0);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    return {
      market: j.market === "ETH" ? "ETH" : "BTC",
      fuelIdx: idx(j.fuelIdx, FUEL_PRESETS.length), fuelCustom: num(j.fuelCustom),
      levIdx: idx(j.levIdx, LEVERAGE_PRESETS.length), levCustom: num(j.levCustom),
    };
  } catch { return { ...DEFAULT_PREFS }; }
}

export function savePrefs(p: TurboPrefs, storage?: Storage | null): void {
  try { (storage ?? window.localStorage).setItem(TURBO_PREFS_KEY, JSON.stringify(p)); } catch { /* memory only */ }
}

export const fuelOf = (p: TurboPrefs) => (p.fuelIdx < 0 && p.fuelCustom > 0 ? p.fuelCustom : FUEL_PRESETS[Math.max(0, p.fuelIdx)]);
export const leverageOf = (p: TurboPrefs) => (p.levIdx < 0 && p.levCustom > 0 ? p.levCustom : LEVERAGE_PRESETS[Math.max(0, p.levIdx)]);

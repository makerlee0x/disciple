/**
 * Swap settings (gear → Swap settings modal / ESC menu amounts): buy preset amounts, slippage, rocket tag.
 * BUY presets: 4 slots, default $10 / $25 / $50 / $100 (DEFAULT_BUY), the player can set their own (`buy`).
 * SELL sizes are FIXED at 10 / 25 / 50 / 100% of the bag (DEFAULT_SELLS; `sells` is kept in the shape for old saves but
 * always sanitizes to the fixed sizes). Each side also has one custom amount field on the trade bar.
 * Persisted per scope: `${storagePrefix}${live ? "live" : "paper"}` (the SIMULATOR passes its own prefix).
 */
export type SellSlot = number;   // % of the position (INITIALS was removed 2026-10; old "init" slots migrate to the new default)
export interface SwapSettings {
  /** the player's 4 buy amounts ($); null = DEFAULT_BUY ($10 / $25 / $50 / $100) */
  buy: number[] | null;
  /** always DEFAULT_SELLS (fixed sell sizes) */
  sells: SellSlot[];
  slippage: { mode: "auto" | "custom"; pct: number };
  tag: boolean;
  v?: number;
}
export const SELL_KEYS = ["KeyZ", "KeyX", "KeyC", "KeyV"] as const;
export const DEFAULT_SELLS: SellSlot[] = [10, 25, 50, 100];
export const DEFAULT_BUY: number[] = [10, 25, 50, 100];
/** v4 (2026-10, GAME trade-ui-fixes): 4 buy presets (was 6 mcap-scaled tiers) and fixed sell sizes. An older 6-slot `buy`
 *  save described the old FEATHER…GLORY ladder, so it resets to the new defaults; every old `sells` save → the fixed sizes. */
export const SETTINGS_VERSION = 4;
export const AUTO_SLIPPAGE_PCT = 1;   // = protocol-viem DEFAULT_SLIPPAGE_BPS (100)
export const DEFAULT_SETTINGS: SwapSettings = { buy: null, sells: DEFAULT_SELLS, slippage: { mode: "auto", pct: AUTO_SLIPPAGE_PCT }, tag: true, v: SETTINGS_VERSION };
export const SWAP_PREFIX = "disciple.swap.";

/** the active buy amounts: the player's own, else the defaults */
export function buyAmounts(s: Pick<SwapSettings, "buy">): number[] { return s.buy && s.buy.length === DEFAULT_BUY.length ? s.buy : DEFAULT_BUY; }
export function sellLabel(s: SellSlot) { return `${+s.toFixed(2)}%`; }
/** live slippage in bps for TradeParams.slippageBps; undefined = protocol default (auto) */
export function slippageBps(s: SwapSettings): number | undefined {
  return s.slippage.mode === "custom" && s.slippage.pct > 0 ? Math.round(Math.min(50, s.slippage.pct) * 100) : undefined;
}
export function sanitize(x: unknown): SwapSettings {
  const o = (x && typeof x === "object" ? x : {}) as Partial<SwapSettings>;
  const buy = Array.isArray(o.buy) && o.buy.length === DEFAULT_BUY.length && o.buy.every((v) => +v > 0 && Number.isFinite(+v)) ? o.buy.map(Number) : null;
  const sells = DEFAULT_SELLS.slice();   // fixed: 10 / 25 / 50 / 100% of the bag
  const sl = o.slippage && (o.slippage.mode === "custom" || o.slippage.mode === "auto") ? { mode: o.slippage.mode, pct: +o.slippage.pct > 0 ? Math.min(50, +o.slippage.pct) : AUTO_SLIPPAGE_PCT } : DEFAULT_SETTINGS.slippage;
  return { buy, sells, slippage: sl, tag: o.tag !== false, v: SETTINGS_VERSION };
}
export function loadSettings(key: string): SwapSettings {
  try { return sanitize(JSON.parse(localStorage.getItem(key) || "null")); } catch { return DEFAULT_SETTINGS; }
}
export function saveSettings(key: string, s: SwapSettings) { try { localStorage.setItem(key, JSON.stringify({ ...s, v: SETTINGS_VERSION })); } catch { /* private mode */ } }

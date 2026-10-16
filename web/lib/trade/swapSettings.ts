/**
 * Swap settings (gear → Swap settings modal): buy/ammo preset overrides, sell % presets, slippage, rocket tag.
 * Persisted per scope: `${storagePrefix}${live ? "live" : "paper"}` (the SIMULATOR passes its own prefix).
 */
export type SellSlot = number | "init";   // % of the position, or "init" = recover the cost basis
export interface SwapSettings {
  /** 6 custom $ amounts for FEATHER…GLORY; null = auto (mcap-scaled ammo tiers, lib/flight/ammoTiers.ts) */
  buy: number[] | null;
  sells: SellSlot[];
  slippage: { mode: "auto" | "custom"; pct: number };
  tag: boolean;
}
export const SELL_KEYS = ["KeyZ", "KeyX", "KeyC", "KeyV"] as const;
export const DEFAULT_SELLS: SellSlot[] = [12, 33, 77, "init"];
export const AUTO_SLIPPAGE_PCT = 1;   // = protocol-viem DEFAULT_SLIPPAGE_BPS (100)
export const DEFAULT_SETTINGS: SwapSettings = { buy: null, sells: DEFAULT_SELLS, slippage: { mode: "auto", pct: AUTO_SLIPPAGE_PCT }, tag: true };
export const SWAP_PREFIX = "disciple.swap.";

export function sellLabel(s: SellSlot) { return s === "init" ? "INITIALS" : `${+s.toFixed(2)}%`; }
/** live slippage in bps for TradeParams.slippageBps; undefined = protocol default (auto) */
export function slippageBps(s: SwapSettings): number | undefined {
  return s.slippage.mode === "custom" && s.slippage.pct > 0 ? Math.round(Math.min(50, s.slippage.pct) * 100) : undefined;
}
export function sanitize(x: unknown): SwapSettings {
  const o = (x && typeof x === "object" ? x : {}) as Partial<SwapSettings>;
  const buy = Array.isArray(o.buy) && o.buy.length === 6 && o.buy.every((v) => +v > 0) ? o.buy.map(Number) : null;
  const sells = Array.isArray(o.sells) && o.sells.length === 4 ? o.sells.map((v, i) => (v === "init" ? "init" : +v > 0 && +v <= 100 ? +v : DEFAULT_SELLS[i])) as SellSlot[] : DEFAULT_SELLS;
  const sl = o.slippage && (o.slippage.mode === "custom" || o.slippage.mode === "auto") ? { mode: o.slippage.mode, pct: +o.slippage.pct > 0 ? Math.min(50, +o.slippage.pct) : AUTO_SLIPPAGE_PCT } : DEFAULT_SETTINGS.slippage;
  return { buy, sells, slippage: sl, tag: o.tag !== false };
}
export function loadSettings(key: string): SwapSettings {
  try { return sanitize(JSON.parse(localStorage.getItem(key) || "null")); } catch { return DEFAULT_SETTINGS; }
}
export function saveSettings(key: string, s: SwapSettings) { try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* private mode */ } }

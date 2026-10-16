/**
 * Swap settings (gear → Swap settings modal): buy/ammo preset overrides, sell % presets, slippage, rocket tag.
 * Persisted per scope: `${storagePrefix}${live ? "live" : "paper"}` (the SIMULATOR passes its own prefix).
 */
export type SellSlot = number;   // % of the position (INITIALS was removed 2026-10; old "init" slots migrate to the new default)
export interface SwapSettings {
  /** 6 custom $ amounts for FEATHER…GLORY; null = auto (mcap-scaled ammo tiers, lib/flight/ammoTiers.ts) */
  buy: number[] | null;
  sells: SellSlot[];
  slippage: { mode: "auto" | "custom"; pct: number };
  tag: boolean;
  v?: number;
}
export const SELL_KEYS = ["KeyZ", "KeyX", "KeyC", "KeyV"] as const;
export const DEFAULT_SELLS: SellSlot[] = [10, 25, 50, 100];
/** Older defaults per settings version (v1 = before the 2026-10 audit, v2 = 25/50/100/INITIALS). A saved slot still equal
 *  to its old default — or set to the removed "init" — is migrated to the new default; any numeric slot the user edited is kept. */
export const OLD_DEFAULT_SELLS: Record<number, (number | "init")[]> = { 1: [12, 33, 77, "init"], 2: [25, 50, 100, "init"] };
export const SETTINGS_VERSION = 3;
export const AUTO_SLIPPAGE_PCT = 1;   // = protocol-viem DEFAULT_SLIPPAGE_BPS (100)
export const DEFAULT_SETTINGS: SwapSettings = { buy: null, sells: DEFAULT_SELLS, slippage: { mode: "auto", pct: AUTO_SLIPPAGE_PCT }, tag: true, v: SETTINGS_VERSION };
export const SWAP_PREFIX = "disciple.swap.";

export function sellLabel(s: SellSlot) { return `${+s.toFixed(2)}%`; }
/** live slippage in bps for TradeParams.slippageBps; undefined = protocol default (auto) */
export function slippageBps(s: SwapSettings): number | undefined {
  return s.slippage.mode === "custom" && s.slippage.pct > 0 ? Math.round(Math.min(50, s.slippage.pct) * 100) : undefined;
}
export function sanitize(x: unknown): SwapSettings {
  const o = (x && typeof x === "object" ? x : {}) as Partial<SwapSettings>;
  const buy = Array.isArray(o.buy) && o.buy.length === 6 && o.buy.every((v) => +v > 0) ? o.buy.map(Number) : null;
  const ver = Math.max(1, Math.min(SETTINGS_VERSION, +(o.v ?? 1) || 1)), olds = ver < SETTINGS_VERSION ? OLD_DEFAULT_SELLS[ver] : null;
  const raw = (Array.isArray(o.sells) ? o.sells : []) as unknown[];
  const sells = raw.length === 4
    ? raw.map((v, i) => (v === "init" || (olds && v === olds[i]) ? DEFAULT_SELLS[i] : +(v as number) > 0 && +(v as number) <= 100 ? +(v as number) : DEFAULT_SELLS[i])) : DEFAULT_SELLS;
  const sl = o.slippage && (o.slippage.mode === "custom" || o.slippage.mode === "auto") ? { mode: o.slippage.mode, pct: +o.slippage.pct > 0 ? Math.min(50, +o.slippage.pct) : AUTO_SLIPPAGE_PCT } : DEFAULT_SETTINGS.slippage;
  return { buy, sells, slippage: sl, tag: o.tag !== false, v: SETTINGS_VERSION };
}
export function loadSettings(key: string): SwapSettings {
  try { return sanitize(JSON.parse(localStorage.getItem(key) || "null")); } catch { return DEFAULT_SETTINGS; }
}
export function saveSettings(key: string, s: SwapSettings) { try { localStorage.setItem(key, JSON.stringify({ ...s, v: SETTINGS_VERSION })); } catch { /* private mode */ } }

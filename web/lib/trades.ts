/** Indexed trade fill (one Trade event from a BondingCurve or the DiscipleHook). Shared client/server. */
export interface Fill {
  /** `${tx}:${logIndex}` — dedupe id */
  id: string;
  tx: string;
  logIndex: number;
  block: number;
  /** ms */
  ts: number;
  coin: string;
  trader: string;
  side: "buy" | "sell";
  /** venue: bonding curve (pre-grad) or v4 hook (post-grad) */
  venue: "curve" | "hook";
  /** token units (18 dec) */
  tokens: number;
  /** $ notional at fill ≈ tokens × mid(priceBefore, priceAfter) in USD (gross, fee inside) */
  usd: number;
  /** $ per token after the fill */
  priceUsd: number;
  /**
   * REAL USDG of a router trade (DiscipleRouter UsdgTrade in the same tx): USDG paid in on a buy, USDG received on a
   * sell (18 dp → $). Absent for direct curve/pool trades or fills indexed before this field existed. Prefer these
   * over `usd` (a mid-price estimate) for P&L.
   */
  usdIn?: number;
  usdOut?: number;
  /** $ mcap after the fill */
  mcapUsd: number;
}
/** Fixed DISCIPLE supply (contracts Constants.TOTAL_SUPPLY = 7B × 1e18). */
export const TOTAL_SUPPLY_TOKENS = 7_000_000_000;

/**
 * Pure: raw Trade args → USD numbers (exported for tests). Units-agnostic.
 *  - BondingCurve Trade (pre-grad): mcapAfterUsd (USD WAD, launch-time quote price) straight from the event.
 *  - DiscipleHook Trade (post-grad, v4 G-1): no mcapAfterUsd (last field = sqrtPriceAfter) ⇒ mcap from priceAfterX18
 *    (quote raw × 1e18 / token raw) × supply × quotePriceUsd (USD WAD per 1e18 quote raw; the coin's launch price).
 */
export function fillUsd(a: { tokenAmt: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd?: bigint; quotePriceUsd?: bigint }) {
  const tokens = Number(a.tokenAmt) / 1e18;
  const mcapUsd = a.mcapAfterUsd !== undefined
    ? Number(a.mcapAfterUsd) / 1e18
    : (Number(a.priceAfterX18) / 1e18) * (Number(a.quotePriceUsd ?? BigInt(0)) / 1e18) * TOTAL_SUPPLY_TOKENS;
  const priceUsd = mcapUsd / TOTAL_SUPPLY_TOKENS;
  const pa = Number(a.priceAfterX18), pb = Number(a.priceBeforeX18);
  const mid = pa > 0 && pb > 0 ? priceUsd * ((pa + pb) / 2 / pa) : priceUsd;
  return { tokens, usd: tokens * mid, priceUsd, mcapUsd };
}

/** DiscipleRouter UsdgTrade args (amountIn = USDG on buys / tokens on sells; amountOut = tokens on buys / USDG on sells). */
export type UsdgTradeArgs = { trader: string; token: string; isBuy: boolean; amountIn: bigint; amountOut: bigint };
/** Key for matching a Trade fill to the router's UsdgTrade of the same tx (token + side). */
export const usdgKey = (tx: string, token: string, isBuy: boolean) => `${tx.toLowerCase()}:${token.toLowerCase()}:${isBuy ? "b" : "s"}`;
/**
 * Pure: UsdgTrade logs → queue per (tx, token, side). Each Trade fill takes the next one, so a batch of 2 router buys
 * in one tx maps 1:1 in log order.
 */
export function usdgIndex(logs: { tx: string; args: UsdgTradeArgs }[]): Map<string, UsdgTradeArgs[]> {
  const m = new Map<string, UsdgTradeArgs[]>();
  for (const l of logs) { const k = usdgKey(l.tx, l.args.token, l.args.isBuy); (m.get(k) ?? m.set(k, []).get(k)!).push(l.args); }
  return m;
}
/** Real $ in/out for a fill from its matched UsdgTrade (USDG has 18 decimals). */
export function usdgAmounts(u: UsdgTradeArgs | undefined): Pick<Fill, "usdIn" | "usdOut"> {
  if (!u) return {};
  return u.isBuy ? { usdIn: Number(u.amountIn) / 1e18 } : { usdOut: Number(u.amountOut) / 1e18 };
}

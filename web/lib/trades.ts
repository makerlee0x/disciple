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

/** sqrtPriceX96 (v4) → $ mcap, full precision (mirrors DiscipleHook.mcapUsdFromSqrt / indexer math.mcapUsdFromSqrt).
 *  tokenIsC0 = token < quote (v4 currency order); quoteUsdWad = USD WAD per 1e18 RAW quote units (decimal-agnostic). */
export function mcapUsdFromSqrt(sqrtP: bigint, tokenIsC0: boolean, quoteUsdWad: bigint, supplyTokens = TOTAL_SUPPLY_TOKENS): number {
  if (sqrtP <= BigInt(0) || quoteUsdWad <= BigInt(0)) return 0;
  const supply = BigInt(Math.round(supplyTokens)) * BigInt(10) ** BigInt(18);
  const mcapQuote = tokenIsC0 ? (sqrtP * sqrtP * supply) >> BigInt(192) : (supply << BigInt(192)) / (sqrtP * sqrtP);
  return Number((mcapQuote * quoteUsdWad) / BigInt(10) ** BigInt(18)) / 1e18;
}
/** v4 currency order: the coin is currency0 iff its address sorts below the quote's. */
export const tokenIsCurrency0 = (token: string, quote: string) => BigInt(token) < BigInt(quote);
/**
 * A Trade's priceBeforeX18/priceAfterX18 (quote raw × 1e18 / token raw) is FLOORED on-chain: with a 6-dec quote (USDG)
 * it is a single-digit integer, so ratios of it are noise. Only trust it with ≥ 6 significant digits.
 */
export const PRICE_X18_MIN_PRECISE = 1_000_000;
export const preciseX18 = (v: bigint | number | undefined) => v !== undefined && Number(v) >= PRICE_X18_MIN_PRECISE;

/**
 * Pure: raw Trade args → USD numbers (exported for tests). Units-agnostic — never derives $ from the floored priceX18
 * fields (6-dec USDG: FLOW #115).
 *  - BondingCurve Trade (pre-grad): mcapAfterUsd (USD WAD, launch-time quote price) straight from the event.
 *  - DiscipleHook Trade (post-grad, v4 G-1): no mcapAfterUsd (last field = sqrtPriceAfter) ⇒ mcap = mcapUsdFromSqrt(
 *    sqrtPriceAfter, token < quote, quotePriceUsd). Legacy fallback (no sqrtPriceAfter / quote given): priceAfterX18 ×
 *    supply × quotePriceUsd — exact only for 18-dec quotes.
 *  - usd = tokens × mid(priceBefore, priceAfter); the mid factor (pb/pa) is applied only when both are precise, else
 *    tokens × price after the fill.
 */
export function fillUsd(a: {
  tokenAmt: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd?: bigint; quotePriceUsd?: bigint;
  /** hook Trade: pool sqrtPriceX96 after the swap + the coin/quote addresses (currency order) */
  sqrtPriceAfter?: bigint; token?: string; quote?: string;
}) {
  const tokens = Number(a.tokenAmt) / 1e18;
  const qp = a.quotePriceUsd ?? BigInt(0);
  const mcapUsd = a.mcapAfterUsd !== undefined
    ? Number(a.mcapAfterUsd) / 1e18
    : a.sqrtPriceAfter !== undefined && a.sqrtPriceAfter > BigInt(0) && a.token && a.quote
      ? mcapUsdFromSqrt(a.sqrtPriceAfter, tokenIsCurrency0(a.token, a.quote), qp)
      : (Number(a.priceAfterX18) / 1e18) * (Number(qp) / 1e18) * TOTAL_SUPPLY_TOKENS;
  const priceUsd = mcapUsd / TOTAL_SUPPLY_TOKENS;
  const pa = Number(a.priceAfterX18), pb = Number(a.priceBeforeX18);
  const mid = preciseX18(pa) && preciseX18(pb) ? priceUsd * ((pa + pb) / 2 / pa) : priceUsd;
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
/**
 * Real $ in/out for a fill from its matched UsdgTrade. `dec` = the chain's USDG decimals (lib/usdg usdgDecimals(): 18 on
 * today's testnet, 6 on mainnet / the redeploy) — required, no 18 default; this file stays import-free (test-share-pnl).
 */
export function usdgAmounts(u: UsdgTradeArgs | undefined, dec: number): Pick<Fill, "usdIn" | "usdOut"> {
  if (!u) return {};
  const usd = (raw: bigint) => Number(raw) / 10 ** dec;
  return u.isBuy ? { usdIn: usd(u.amountIn) } : { usdOut: usd(u.amountOut) };
}

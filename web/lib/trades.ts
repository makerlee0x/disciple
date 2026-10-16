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
  /** $ mcap after the fill */
  mcapUsd: number;
}
/** Fixed DISCIPLE supply (contracts Constants.TOTAL_SUPPLY = 7B × 1e18). */
export const TOTAL_SUPPLY_TOKENS = 7_000_000_000;

/** Pure: raw Trade args → USD numbers (exported for tests). Units-agnostic: uses mcapAfterUsd and the price ratio. */
export function fillUsd(a: { tokenAmt: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd: bigint }) {
  const tokens = Number(a.tokenAmt) / 1e18;
  const mcapUsd = Number(a.mcapAfterUsd) / 1e18;
  const priceUsd = mcapUsd / TOTAL_SUPPLY_TOKENS;
  const pa = Number(a.priceAfterX18), pb = Number(a.priceBeforeX18);
  const mid = pa > 0 && pb > 0 ? priceUsd * ((pa + pb) / 2 / pa) : priceUsd;
  return { tokens, usd: tokens * mid, priceUsd, mcapUsd };
}

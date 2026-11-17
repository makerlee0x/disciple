/**
 * COPY of web/lib/v4Swap.ts (keep in sync; the indexer is its own package).
 * Post-graduation trades from Uniswap's own PoolManager `Swap` event (slim DiscipleHook, 2026-11-17).
 *
 * The slim hook emits nothing: it only takes the 1% fee (afterSwapReturnDelta → FeeRouter). Trades, prices and market
 * caps are read from the PoolManager Swap log of the coin's DISCIPLE pool, and the trader from our router's events in the
 * same tx (DiscipleRouter PoolTrade / UsdgTrade, GaslessTrade's signer), else the tx sender.
 *
 * `hookTradeFromSwap` turns one Swap into the SAME args the old hook `Trade` event carried
 * (token, trader, isBuy, quoteAmt, tokenAmt, fee, snipeFee, priceBeforeX18, priceAfterX18, impactBps, sqrtPriceAfter),
 * so every consumer (feed, chart, fills, P&L) keeps working unchanged. Stacks deployed with the old hook still emit
 * the legacy hook Trade (LEGACY_HOOK_TRADE); callers read both and drop Swap rows of a tx that already has a hook Trade.
 *
 * Swap amounts are the pool's swap delta BEFORE the hook fee, from the caller's side (negative = paid in). Our router
 * only does exact-in swaps, so the 1% is taken from the output: net out = gross out − floor(gross out × 1%). The
 * price before is rebuilt from the token1 delta and the in-range liquidity (√Pbefore = √Pafter + amount1 × 2^96 / L),
 * exact unless the swap crossed an initialized tick (floor bands / tramps), where the impact is approximate.
 */
import { encodeAbiParameters, keccak256, parseAbiItem, type Address, type Hex } from "viem";

/** PoolManager.Swap (v4-core IPoolManager). */
export const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
/** Old DiscipleHook (≤ 2026-11-17 stacks): Trade(…, uint160 sqrtPriceAfter). The slim hook has no events. */
export const LEGACY_HOOK_TRADE = parseAbiItem(
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmt, uint256 tokenAmt, uint256 fee, uint256 snipeFee, uint256 priceBeforeX18, uint256 priceAfterX18, uint256 impactBps, uint160 sqrtPriceAfter)",
);
/** DiscipleRouter.PoolTrade: post-grad buyExactIn / sellExactIn (pair coin in or out). */
export const POOL_TRADE_EVENT = parseAbiItem(
  "event PoolTrade(address indexed trader, address indexed token, bool isBuy, uint256 amountIn, uint256 amountOut, address recipient)",
);

/** Migration.POOL_FEE / TICK_SPACING: every DISCIPLE pool is (token, quote, fee 0, tickSpacing 60, hook). */
export const DISCIPLE_POOL_FEE = 0;
export const DISCIPLE_TICK_SPACING = 60;
const TRADE_FEE_BPS = BigInt(100);
const BPS = BigInt(10_000);
const Q96 = BigInt(2) ** BigInt(96);
const WAD = BigInt(10) ** BigInt(18);
const ZERO = BigInt(0);

/** v4 PoolId of a coin's DISCIPLE pool: keccak256(abi.encode(PoolKey)). */
export function disciplePoolId(token: string, quote: string, hook: string): Hex {
  const [c0, c1] = BigInt(token) < BigInt(quote) ? [token, quote] : [quote, token];
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [c0 as Address, c1 as Address, DISCIPLE_POOL_FEE, DISCIPLE_TICK_SPACING, hook as Address],
  ));
}

export type SwapArgs = { id?: Hex; sender?: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint };
/** Same fields as the old hook Trade event. */
export type HookTradeArgs = {
  token: Address; trader: Address; isBuy: boolean; quoteAmt: bigint; tokenAmt: bigint; fee: bigint; snipeFee: bigint;
  priceBeforeX18: bigint; priceAfterX18: bigint; impactBps: bigint; sqrtPriceAfter: bigint;
};

const abs = (x: bigint) => (x < ZERO ? -x : x);

/** quote raw × 1e18 / token raw from sqrtPriceX96 (same as the old DiscipleHook.priceX18FromSqrt). */
export function priceX18FromSqrt(sqrtP: bigint, tokenIsC0: boolean): bigint {
  if (sqrtP <= ZERO) return ZERO;
  const pX192 = sqrtP * sqrtP;
  return tokenIsC0 ? (pX192 * WAD) >> BigInt(192) : (WAD << BigInt(192)) / pX192;
}

/** |Δprice| / price in bps (old DiscipleHook.impactBpsFromSqrt). */
export function impactBpsFromSqrt(sb: bigint, sa: bigint, tokenIsC0: boolean): bigint {
  if (sb <= ZERO || sa <= ZERO) return ZERO;
  const d = abs(sa - sb), sum = sa + sb, root = tokenIsC0 ? sb : sa;
  return (((d * sum) / root) * BPS) / root;
}

/** One Swap → hook-Trade args. `trader` comes from the router event of the same tx (see traderOf). */
export function hookTradeFromSwap(s: SwapArgs, token: string, quote: string, trader: string): HookTradeArgs {
  const tokenIsC0 = BigInt(token) < BigInt(quote);
  const dTok = tokenIsC0 ? s.amount0 : s.amount1, dQuote = tokenIsC0 ? s.amount1 : s.amount0;
  const isBuy = dTok > ZERO; // caller receives the coin
  const grossOut = abs(isBuy ? dTok : dQuote);
  const fee = (grossOut * TRADE_FEE_BPS) / BPS;
  const sa = s.sqrtPriceX96;
  let sb = s.liquidity > ZERO ? sa + (s.amount1 * Q96) / s.liquidity : sa;
  if (sb <= ZERO) sb = sa;
  const feeQuote = isBuy
    ? (tokenIsC0 ? (((fee * sa) / Q96) * sa) / Q96 : (((fee * Q96) / sa) * Q96) / sa)
    : fee;
  return {
    token: token as Address, trader: trader as Address, isBuy,
    quoteAmt: isBuy ? abs(dQuote) : grossOut - fee,
    tokenAmt: isBuy ? grossOut - fee : abs(dTok),
    fee: feeQuote, snipeFee: ZERO,
    priceBeforeX18: priceX18FromSqrt(sb, tokenIsC0), priceAfterX18: priceX18FromSqrt(sa, tokenIsC0),
    impactBps: impactBpsFromSqrt(sb, sa, tokenIsC0), sqrtPriceAfter: sa,
  };
}

/** Router events that name the trader behind a Swap in the same tx. */
export type TraderHint = { tx: string; trader: string; token?: string; isBuy?: boolean };
/** tx → trader for (token, side), first match in log order; any hint of the tx as a fallback. */
export function traderIndex(hints: readonly TraderHint[]) {
  const m = new Map<string, TraderHint[]>();
  for (const h of hints) { const k = h.tx.toLowerCase(); (m.get(k) ?? m.set(k, []).get(k)!).push(h); }
  return (tx: string, token: string, isBuy: boolean): string | undefined => {
    const hs = m.get(tx.toLowerCase()); if (!hs?.length) return undefined;
    const exact = hs.find((h) => (!h.token || h.token.toLowerCase() === token.toLowerCase()) && (h.isBuy === undefined || h.isBuy === isBuy));
    return (exact ?? hs[0]).trader;
  };
}

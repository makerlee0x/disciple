/**
 * Graduation reads shared by the client trade layer (protocol-viem) and the relay / paymaster (lib/server/gradBuy),
 * for curves of ANY quote token (USDG or STRATEGY …). Pure viem reads, no client-only deps (server-importable).
 *
 *  - usdgBuyGraduates: does DiscipleRouter.buyWithUsdg(token, usdgIn) graduate a pre-grad curve whose quote is NOT USDG?
 *    Mirrors what the router does on-chain (buyWithUsdg pre-grad: swap USDG → quote through its registered pool, then
 *    curve.routerBuy(quoteAmt)): router.quoteUsdgQuoteSwap(quote, true, usdgIn) → curve.quoteBuy(quoteAmt ⊕ margin).graduates.
 *    The margin (GRAD_QUOTE_MARGIN_BPS) absorbs pool drift between the check and execution; a buy flagged inside the
 *    margin that ends up not graduating just uses less gas (gas is charged on use). The relay applies the SAME rule.
 *  - readGradNeed: the exact amount left to graduate a curve (tokens, quote in, USDG in) — GAME UI.
 */
import { parseAbi, type Address, type PublicClient } from "viem";
import { bondingCurveAbi } from "../abi/BondingCurve";
import { deployment } from "../chains";

/** Headroom on the converted quote amount when deciding "graduates" for a USDG-routed buy (0.5%). */
export const GRAD_QUOTE_MARGIN_BPS = BigInt(50);
const BPS = BigInt(10_000);
export const withGradMargin = (quoteAmt: bigint) => quoteAmt + (quoteAmt * GRAD_QUOTE_MARGIN_BPS) / BPS;

export const routerQuoteSwapAbi = parseAbi([
  "function quoteUsdgQuoteSwap(address quote, bool toQuote, uint256 amountIn) returns (uint256 amountOut, uint256 impactBps)",
  "function maxImpactBps() view returns (uint256)",
]);

/** USDG → `quote` through the router's registered USDG/quote pool (eth_call of the router's own simulation). */
export async function usdgToQuote(pc: PublicClient, router: Address, quote: Address, usdgIn: bigint): Promise<bigint> {
  const { result } = await pc.simulateContract({ address: router, abi: routerQuoteSwapAbi, functionName: "quoteUsdgQuoteSwap", args: [quote, true, usdgIn] });
  return result[0];
}

/** buyWithUsdg(usdgIn) on a pre-grad curve quoted in `quote` (≠ USDG) graduates it? (see header; false when unreadable) */
export async function usdgBuyGraduates(pc: PublicClient, a: { router: Address; curve: Address; quote: Address; usdgIn: bigint }): Promise<boolean> {
  try {
    const q = await usdgToQuote(pc, a.router, a.quote, a.usdgIn);
    if (q <= BigInt(0)) return false;
    const r = await pc.readContract({ address: a.curve, abi: bondingCurveAbi, functionName: "quoteBuy", args: [withGradMargin(q)] });
    return r.graduates;
  } catch { return false; }
}

export type GradNeed = {
  curve: Address; quote: Address; graduated: boolean;
  /** Tokens left on the curve before graduation (sCurve − tokensSold); 0 once graduated. */
  remainingTokens: bigint;
  /** Smallest quote-token input (raw, incl. fees / sniper tax) whose buy takes all remaining tokens (= graduates). */
  quoteIn: bigint;
  /** USDG (raw, 6 dec) for buyWithUsdg to graduate: = quoteIn on USDG-quoted curves; else the router's USDG→quote
   *  swap inverted (rounded up, then +0.1% so the swap lands ≥ quoteIn). null when the router can't route it. */
  usdgIn: bigint | null;
};
const HUGE = BigInt(10) ** BigInt(30);
const NEED = new Map<string, { at: number; v: Promise<GradNeed> }>();

/**
 * Exact amount needed to graduate `curve`, read from the curve: tokens left, quote input (curve.quoteBuy of a huge
 * input: the curve charges only what the remaining tokens cost and refunds the rest ⇒ need = input − refund), and the
 * USDG input through `router` (if given). Cached per curve for `maxAgeMs` (default 1.5 s).
 */
export function readGradNeed(pc: PublicClient, curve: Address, o: { router?: Address; usdg?: Address; maxAgeMs?: number } = {}): Promise<GradNeed> {
  const k = `${curve.toLowerCase()}|${(o.router ?? "").toLowerCase()}`;
  const hit = NEED.get(k);
  if (hit && Date.now() - hit.at <= (o.maxAgeMs ?? 1500)) return hit.v;
  const v = readGradNeedNow(pc, curve, o);
  NEED.set(k, { at: Date.now(), v });
  v.catch(() => NEED.delete(k));
  return v;
}
async function readGradNeedNow(pc: PublicClient, curve: Address, o: { router?: Address; usdg?: Address }): Promise<GradNeed> {
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const [graduated, quote, params, sold] = await Promise.all([
    pc.readContract({ ...c, functionName: "graduated" }), pc.readContract({ ...c, functionName: "quote" }),
    pc.readContract({ ...c, functionName: "curveParams" }), pc.readContract({ ...c, functionName: "tokensSold" }),
  ]);
  const zero = BigInt(0);
  if (graduated) return { curve, quote, graduated, remainingTokens: zero, quoteIn: zero, usdgIn: zero };
  const sCurve = (params as readonly bigint[])[1];
  const remainingTokens = sCurve > sold ? sCurve - sold : zero;
  const qb = await pc.readContract({ ...c, functionName: "quoteBuy", args: [HUGE] });
  const quoteIn = HUGE - qb.refund;
  let usdgIn: bigint | null = null;
  if (o.usdg && quote.toLowerCase() === o.usdg.toLowerCase()) usdgIn = quoteIn;
  else if (o.router) usdgIn = await usdgForQuote(pc, o.router, quote, quoteIn).catch(() => null);
  return { curve, quote, graduated, remainingTokens, quoteIn, usdgIn };
}
/** Smallest-ish USDG whose router swap yields ≥ `quoteNeed` of `quote` (two secant steps on the router's own quote). */
export async function usdgForQuote(pc: PublicClient, router: Address, quote: Address, quoteNeed: bigint): Promise<bigint> {
  if (quoteNeed <= BigInt(0)) return BigInt(0);
  const probe = BigInt(1_000_000);   // 1 USDG
  const out1 = await usdgToQuote(pc, router, quote, probe);
  if (out1 <= BigInt(0)) throw new Error("no USDG route");
  let x = (quoteNeed * probe + out1 - BigInt(1)) / out1;
  for (let i = 0; i < 4; i++) {
    const out = await usdgToQuote(pc, router, quote, x);
    if (out <= BigInt(0)) throw new Error("no USDG route");
    if (out >= quoteNeed && i > 0) return x;
    x = (x * quoteNeed + out - BigInt(1)) / out;   // secant toward the target
    x += x / BigInt(1000) + BigInt(1);             // +0.1% so the swap lands on or above the need
  }
  return x;
}

/**
 * DiscipleRouter.maxImpactBps — the per-hop price-impact cap behind PriceImpactTooHigh (read on-chain, never assumed),
 * cached per router for `maxAgeMs` (default 60 s). router defaults to the active deployment's router.
 */
const IMPACT = new Map<string, { at: number; v: Promise<number> }>();
export function readRouterMaxImpactBps(pc: PublicClient, router: Address = deployment().router, maxAgeMs = 60_000): Promise<number> {
  const k = router.toLowerCase(), hit = IMPACT.get(k);
  if (hit && Date.now() - hit.at <= maxAgeMs) return hit.v;
  const v = pc.readContract({ address: router, abi: routerQuoteSwapAbi, functionName: "maxImpactBps" }).then(Number);
  IMPACT.set(k, { at: Date.now(), v });
  v.catch(() => IMPACT.delete(k));
  return v;
}

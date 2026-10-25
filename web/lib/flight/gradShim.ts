/**
 * SHIMS for SITE (GAME graduation fix, item 3). GAME does not edit protocol-viem.ts / gradBuy.ts / gasPolicy.ts / wallet.ts /
 * lib/config / lib/aa; it only READS through their existing exports here. SITE's grad PR (branch site/grad-any-pair) will
 * export the real helpers; then replace these bodies with re-exports and keep the names/shapes:
 *   getMaxImpactBps(): Promise<number>        router max price impact in bps, cached; 0 = no cap
 *   getGraduationBuy(token): Promise<{ remainingTokens: bigint; inputNeeded: bigint; quoteToken: string } | null>
 *   graduationBuyUsd(token, g): Promise<number | null>   (GAME helper: $ for the GRADUATE button, rounded up to the cent)
 * classifyTradeError lives in ./tradeErrorShim (pure, testable).
 */
import type { Address } from "@/lib/protocol";
import { deployment, hasRouter } from "@/lib/chains";
import { discipleRouterAbi } from "@/lib/abi/DiscipleRouter";
import { bondingCurveAbi } from "@/lib/abi/BondingCurve";
import { coinFacts, publicClient, usdToAmountIn } from "@/lib/protocol-viem";
import { graduateUsd, graduationFromProbe } from "./tradeGate";

const MIN_SHOT = 0.2;   // engine MIN_SHOT (public/flight/engine.js): the smallest buy the game sends

let impactCache: { v: number; at: number } | null = null;
let impactInflight: Promise<number> | null = null;
const IMPACT_TTL = 30_000;
/**
 * TODO(SITE): replace with SITE's export. Router's on-chain max price impact (DiscipleRouter.maxImpactBps, v5 router; 5000
 * on testnet 2026-10-24 — PriceImpactTooHigh(x, 5000) on IRON). Cached 30 s. 0 / unreadable / no router ⇒ 0 = NO CAP
 * (nothing greys out; lee may add a no-cap mode).
 */
export async function getMaxImpactBps(): Promise<number> {
  if (impactCache && Date.now() - impactCache.at < IMPACT_TTL) return impactCache.v;
  if (impactInflight) return impactInflight;
  impactInflight = (async () => {
    try {
      if (!hasRouter()) return 0;
      const v = Number(await publicClient().readContract({ address: deployment().router, abi: discipleRouterAbi, functionName: "maxImpactBps" }));
      const n = Number.isFinite(v) && v > 0 ? v : 0;
      impactCache = { v: n, at: Date.now() };
      return n;
    } catch { return impactCache?.v ?? 0; } finally { impactInflight = null; }
  })();
  return impactInflight;
}

/** Probe size for the graduation quote: well above any remaining raise (the curve refunds the excess in the quote). */
const PROBE_USD = 1_000_000;
/**
 * TODO(SITE): replace with SITE's export (remaining tokens + the quote/USDG input needed, from the curve). Today: ONE
 * oversized curve quoteBuy — the curve fills to graduation and reports the refund (lib/flight/tradeGate graduationFromProbe).
 * null ⇒ graduated, not a curve coin, or the probe doesn't graduate (not close / read failed).
 */
export async function getGraduationBuy(token: string): Promise<{ remainingTokens: bigint; inputNeeded: bigint; quoteToken: string } | null> {
  try {
    const pc = publicClient(), t = token as Address;
    const f = await coinFacts(pc, t);
    if (f.graduated) return null;
    const probeIn = await usdToAmountIn(pc, t, "buy", PROBE_USD);
    const q = await pc.readContract({ address: f.curve, abi: bondingCurveAbi, functionName: "quoteBuy", args: [probeIn] });
    const g = graduationFromProbe(probeIn, q);
    return g ? { ...g, quoteToken: f.quote } : null;
  } catch { return null; }
}

/** $ for the GRADUATE button (inputNeeded in the quote token → USD via the launch-fixed quotePriceUsd; USDG-quoted ⇒ 1:1). */
export async function graduationBuyUsd(token: string, g: { inputNeeded: bigint; quoteToken: string }): Promise<number | null> {
  try {
    const pc = publicClient(), f = await coinFacts(pc, token as Address);
    const d = deployment(), quoteIsUsdg = g.quoteToken.toLowerCase() === d.usdg.toLowerCase();
    const qp = quoteIsUsdg ? BigInt(0) : await pc.readContract({ address: f.curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" });
    const usd = graduateUsd({ inputNeeded: g.inputNeeded, quoteIsUsdg, usdgDecimals: d.usdgDecimals, quotePriceUsd: qp, minShot: MIN_SHOT });
    return usd > 0 ? usd : null;
  } catch { return null; }
}

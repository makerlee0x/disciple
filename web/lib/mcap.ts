/**
 * THE market cap (data retest #2): one source of truth for every surface — home/launchpad cards, the coin page header,
 * the HUD self-heal, the holders list, the portfolio, live/backfilled Trade events and /api/trades fills.
 *
 *   mcapUsd = curve.marketCapQuote() × curve.quotePriceUsd() / 1e18
 *
 *  - marketCapQuote(): the curve's own full-precision mcap in RAW quote units, from its reserves pre-grad and from the v4
 *    pool's sqrtPrice post-grad, × the coin's OWN supply (_params.totalSupply — 7B on the old testnet coins, whatever the
 *    coin launched with on newer ones; never a hardcoded constant).
 *  - quotePriceUsd(): the coin's launch-time quote price (immutable). The same basis as the curve's pre-grad
 *    marketCapUsd()/Trade.mcapAfterUsd, the hook's Trade/AltitudeUpdate/TierBreak events and the $ graduation target, so
 *    the header, the cards and every chart point/fill agree to the cent and don't drift when the quote token moves.
 *    (MarketLens.market() and the curve's post-grad marketCapUsd() price the quote with the LIVE QuotePricer instead ⇒
 *    they disagreed with the chart by ~0.10% on RPGD; neither is used for display any more.)
 *
 * Event-derived mcaps (hook Trade sqrtPriceAfter) go through `hookMcapUsd` below with the same launch price and the
 * coin's own supply (`coinBasis`).
 */
import type { Address, PublicClient } from "viem";
import { bondingCurveAbi, launchpadAbi, marketLensAbi, tokenAbi } from "./abi";
import { deployment, hasLens, ZERO } from "./chains";
import { CURVE } from "./config";
import { mcapUsdFromSqrt, tokenIsCurrency0 } from "./trades";

const WAD = BigInt(10) ** BigInt(18);

/** Pure: raw-quote mcap × launch quote price (USD WAD per 1e18 raw quote) → $ (exact integer math, one final float). */
export function mcapUsdFromQuote(mcapQuoteRaw: bigint, launchQuoteUsdWad: bigint): number {
  if (mcapQuoteRaw <= BigInt(0) || launchQuoteUsdWad <= BigInt(0)) return 0;
  return Number((mcapQuoteRaw * launchQuoteUsdWad) / WAD) / 1e18;
}

/**
 * Pure: graduation progress 0–100 from the mcap on the same basis (live retest #4). Matches the curve's progressBps()
 * (tokensSold / sCurve) exactly: CurveMath is x·y = x0·y0 with y = y0 − sold and mcap = x·S/y ∝ 1/(y0 − sold)², so
 * sold/y0 = 1 − √(M0/M) and progress = (1 − √(M0/M)) / (1 − √(M0/Mgrad)). M0 / Mgrad = the coin's LaunchTierContext
 * startMcapUsd / graduationMcapUsd (default $7K / $33K). It was mcap-linear ((M − M0)/(Mgrad − M0)): 79% on RPNR
 * where the curve says 91.8%. `null` when the mcap is unknown.
 */
export function graduationPct(mcapUsd: number | null | undefined, startMcapUsd: number = CURVE.startMcap, graduationMcapUsd: number = CURVE.graduationMcap): number | null {
  if (mcapUsd == null || !Number.isFinite(mcapUsd)) return null;
  if (!(startMcapUsd > 0) || !(graduationMcapUsd > startMcapUsd)) return null;
  if (mcapUsd >= graduationMcapUsd) return 100;
  if (mcapUsd <= startMcapUsd) return 0;
  const p = (1 - Math.sqrt(startMcapUsd / mcapUsd)) / (1 - Math.sqrt(startMcapUsd / graduationMcapUsd));
  return Math.max(0, Math.min(100, p * 100));
}
/** The curve's own progressBps() → 0–100 (exact; 10000 once graduated). */
export const pctFromBps = (bps: number | null | undefined): number | null => (bps == null || !Number.isFinite(bps) ? null : Math.max(0, Math.min(100, bps / 100)));

/** Pure: a hook Trade's sqrtPriceAfter → $ mcap on the same basis (launch quote price × the coin's own supply). */
export function hookMcapUsd(sqrtPriceAfter: bigint, token: string, quote: string, launchQuoteUsdWad: bigint, supplyTokens: number): number {
  return mcapUsdFromSqrt(sqrtPriceAfter, tokenIsCurrency0(token, quote), launchQuoteUsdWad, supplyTokens);
}

/** A coin's immutable mcap basis: its quote token, launch quote price and own total supply (whole tokens). */
export type CoinBasis = { curve: Address; quote: Address; launchQuoteUsd: bigint; supplyRaw: bigint; supplyTokens: number };
const BASIS = new Map<string, Promise<CoinBasis>>();
export function coinBasis(pc: PublicClient, token: Address, curve: Address): Promise<CoinBasis> {
  const k = `${token}:${curve}`.toLowerCase();
  let p = BASIS.get(k);
  if (!p) {
    const c = { address: curve, abi: bondingCurveAbi } as const;
    p = Promise.all([
      pc.readContract({ ...c, functionName: "quote" }),
      pc.readContract({ ...c, functionName: "quotePriceUsd" }),
      pc.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }),
    ]).then(([quote, qp, supply]) => ({ curve, quote: quote as Address, launchQuoteUsd: qp as bigint, supplyRaw: supply as bigint, supplyTokens: Number(supply as bigint) / 1e18 }));
    p.catch(() => BASIS.delete(k));
    BASIS.set(k, p);
  }
  return p;
}

export type CoinMcap = {
  mcapUsd: number; priceUsd: number;
  /** quote raw × 1e18 / token raw, full precision (not the floored on-chain spot) */
  priceWad: bigint;
  graduated: boolean; supplyTokens: number;
  /** "curve" = the source of truth above; "lens" = fallback for a curve without marketCapQuote() (pre-v4 stacks) */
  source: "curve" | "lens";
};

/** Live mcap of a coin from chain (see file header). `curve` skips the Launchpad.curveOf read. Throws on RPC failure. */
export async function readCoinMcap(pc: PublicClient, token: Address, curve?: Address): Promise<CoinMcap> {
  const cv = curve ?? (await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] }) as Address);
  if (!cv || cv === ZERO) throw new Error("unknown coin");
  const c = { address: cv, abi: bondingCurveAbi } as const;
  const [b, graduated, mq] = await Promise.all([
    coinBasis(pc, token, cv),
    pc.readContract({ ...c, functionName: "graduated" }) as Promise<boolean>,
    pc.readContract({ ...c, functionName: "marketCapQuote" }).then((v) => v as bigint, () => null),
  ]);
  if (mq !== null) {
    const mcapUsd = mcapUsdFromQuote(mq, b.launchQuoteUsd);
    return { mcapUsd, priceUsd: b.supplyTokens > 0 ? mcapUsd / b.supplyTokens : 0, priceWad: b.supplyRaw > BigInt(0) ? (mq * WAD) / b.supplyRaw : BigInt(0), graduated, supplyTokens: b.supplyTokens, source: "curve" };
  }
  // pre-v4 curve (no marketCapQuote): its post-grad mcapNow froze ⇒ MarketLens (live pricer) is the only correct read.
  if (!hasLens()) throw new Error("no marketCapQuote and no MarketLens");
  const [priceWad, m] = await pc.readContract({ address: deployment().marketLens, abi: marketLensAbi, functionName: "market", args: [token] });
  const mcapUsd = Number(m) / 1e18;
  return { mcapUsd, priceUsd: b.supplyTokens > 0 ? mcapUsd / b.supplyTokens : 0, priceWad, graduated, supplyTokens: b.supplyTokens, source: "lens" };
}

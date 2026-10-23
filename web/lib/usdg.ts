/**
 * USDG decimals — ONE helper for every $ ⇄ USDG raw conversion. Driven by config (Deployment.usdgDecimals per chain:
 * 18 for today's testnet mUSDG, 6 for mainnet USDG and the testnet redeploy), never by a literal 18 / 1e12.
 * Also the known-decimals table (USDG, default quote, DISCIPLE coins) so callers never fall back to a guessed 18.
 */
import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";
import { tokenAbi } from "./abi";
import { deployment, type Deployment } from "./chains";
import { CURVE, STRATEGY_TOKEN } from "./config";

const lc = (a: string) => a.toLowerCase();
export const usdgDecimals = (d: Pick<Deployment, "usdgDecimals"> = deployment()) => d.usdgDecimals;
export const isUsdg = (a: string | null | undefined, d: Pick<Deployment, "usdg"> = deployment()) => !!a && lc(a) === lc(d.usdg);

/** $ → USDG raw ($1 = 1 USDG), rounded to the cent-micro (6 dp, or fewer if USDG has fewer). ≤ 0 / NaN ⇒ 0. */
export function usdToUsdgRaw(usd: number, dec: number = usdgDecimals()): bigint {
  if (!(usd > 0) || !Number.isFinite(usd)) return BigInt(0);
  return parseUnits(usd.toFixed(Math.min(6, dec)), dec);
}
/** USDG raw → $ (number). */
export const usdgRawToUsd = (raw: bigint, dec: number = usdgDecimals()) => Number(formatUnits(raw, dec));
/**
 * $1 expressed like QuotePricer.quotePriceUsd (USD WAD per 1e18 RAW units): 1e18 × 10^(18 − dec) = 10^(36 − dec).
 * 18-dec ⇒ 1e18; 6-dec ⇒ 1e30. Used as the USDG fallback price.
 */
export const usdgPriceWadPer1e18Raw = (dec: number = usdgDecimals()) => BigInt(10) ** BigInt(36 - dec);

/**
 * Decimals known from config without an RPC: USDG (usdgDecimals), the default quote (STRATEGY), and `coins` (DISCIPLE
 * launch tokens are fixed CURVE.decimals). undefined ⇒ must be read on-chain.
 */
export function knownDecimals(token: string, d: Pick<Deployment, "usdg" | "usdgDecimals" | "defaultQuote"> = deployment()): number | undefined {
  if (isUsdg(token, d)) return d.usdgDecimals;
  if (lc(token) === lc(d.defaultQuote) || lc(token) === lc(STRATEGY_TOKEN.address)) return STRATEGY_TOKEN.decimals;
  return undefined;
}
export const COIN_DECIMALS = CURVE.decimals;

const decCache = new Map<string, number>();
/** ERC-20 decimals: config first (USDG / STRATEGY), else decimals() on-chain (cached). Throws on RPC failure — no guessing. */
export async function tokenDecimals(pc: PublicClient, token: Address): Promise<number> {
  const known = knownDecimals(token); if (known !== undefined) return known;
  const k = lc(token), hit = decCache.get(k); if (hit !== undefined) return hit;
  const v = Number(await pc.readContract({ address: token, abi: tokenAbi, functionName: "decimals" }));
  decCache.set(k, v); return v;
}

/** Read-only sanity check: config usdgDecimals vs the token's on-chain decimals(). */
export async function checkUsdgDecimals(pc: PublicClient, d: Deployment = deployment()): Promise<{ config: number; onchain: number; ok: boolean }> {
  const onchain = Number(await pc.readContract({ address: d.usdg, abi: tokenAbi, functionName: "decimals" }));
  return { config: d.usdgDecimals, onchain, ok: onchain === d.usdgDecimals };
}

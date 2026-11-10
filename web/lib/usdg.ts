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
/**
 * USDG's own decimals() read ONCE per page/process and cached (item e / #115): set from the paymaster cap warm-up that
 * already reads usdg.decimals() (no extra RPC, never per trade). Until then — or for another token address — config.
 */
let onchainDec: { usdg: string; raw: string; dec: number } | undefined;
export function setUsdgDecimalsOnchain(usdg: string, dec: number) {
  if (!Number.isInteger(dec) || dec < 0 || dec > 36 || !usdg) return;
  const d = deployment();
  if (lc(usdg) !== lc(d.usdg)) return;
  if (dec !== d.usdgDecimals && onchainDec?.dec !== dec) console.warn("[disciple] USDG decimals: config differs from the token; using the token", { config: d.usdgDecimals, onchain: dec });
  onchainDec = { usdg: lc(usdg), raw: d.usdg, dec };
}
/** Test hook. */
export function resetUsdgDecimalsCache() { onchainDec = undefined; }
/** The active deployment's USDG decimals (cached on-chain value once read, else config); an explicit `d` is used as given. */
export function usdgDecimals(d?: Pick<Deployment, "usdgDecimals">): number {
  if (d) return d.usdgDecimals;
  const dep = deployment();
  if (!onchainDec) return dep.usdgDecimals;
  // hot path: same deployment string as when set ⇒ no lower-casing per call
  return onchainDec.raw === dep.usdg || onchainDec.usdg === lc(dep.usdg) ? onchainDec.dec : dep.usdgDecimals;
}
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
export function knownDecimals(token: string, d0?: Pick<Deployment, "usdg" | "usdgDecimals" | "defaultQuote">): number | undefined {
  const d = d0 ?? deployment();
  if (isUsdg(token, d)) return d0 ? d.usdgDecimals : usdgDecimals();
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

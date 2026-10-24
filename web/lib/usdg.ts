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
 * USDG decimals. With an explicit `d`: that deployment's config. Without: the active chain's on-chain decimals() once
 * readUsdgDecimals() has read them (cached), else config. Reservations, cash checks and $ ⇄ raw all go through this.
 */
export function usdgDecimals(d?: Pick<Deployment, "usdgDecimals">): number {
  if (d) return d.usdgDecimals;
  const cur = deployment();
  return LIVE_DEC && lc(LIVE_DEC.usdg) === lc(cur.usdg) ? LIVE_DEC.dec : cur.usdgDecimals;
}
let LIVE_DEC: { usdg: string; dec: number } | undefined;
const decReads = new Map<string, Promise<number>>();
/**
 * Read the active USDG's decimals() from the chain ONCE per address (shared promise, cached for the page) and make
 * usdgDecimals() use it. A failed read is not cached (config is used meanwhile; the next call retries). A mismatch with
 * config is logged (console only). Hot path: after the first read this is an already-resolved promise (no RPC).
 */
export function readUsdgDecimals(pc: Pick<PublicClient, "readContract">, d: Pick<Deployment, "usdg" | "usdgDecimals"> = deployment()): Promise<number> {
  const k = lc(d.usdg);
  if (/^0x0{40}$/.test(k)) return Promise.resolve(d.usdgDecimals);
  let p = decReads.get(k);
  if (!p) {
    p = pc.readContract({ address: d.usdg as Address, abi: tokenAbi, functionName: "decimals" }).then((v) => {
      const dec = Number(v);
      if (!Number.isInteger(dec) || dec < 0 || dec > 36) throw new Error(`bad USDG decimals ${String(v)}`);
      if (dec !== d.usdgDecimals && typeof console !== "undefined") console.warn("[disciple] USDG decimals: config differs from chain, using chain", { config: d.usdgDecimals, chain: dec });
      LIVE_DEC = { usdg: k, dec };
      return dec;
    });
    p.catch(() => decReads.delete(k));
    decReads.set(k, p);
  }
  return p;
}
/** Tests: forget the chain-read decimals. */
export function resetUsdgDecimals() { LIVE_DEC = undefined; decReads.clear(); }
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
export function knownDecimals(token: string, d?: Pick<Deployment, "usdg" | "usdgDecimals" | "defaultQuote">): number | undefined {
  const dd = d ?? deployment();
  if (isUsdg(token, dd)) return d ? d.usdgDecimals : usdgDecimals();   // no explicit deployment ⇒ chain-read when known
  if (lc(token) === lc(dd.defaultQuote) || lc(token) === lc(STRATEGY_TOKEN.address)) return STRATEGY_TOKEN.decimals;
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

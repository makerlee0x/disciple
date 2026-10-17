/**
 * First BOOST: the creator's optional buy inside the launch tx (Launchpad LaunchParams.creatorBuyQuoteIn).
 * Capped on-chain at Launchpad.creatorBuyMaxBps() of supply and exempt from anti-snipe. All copy lives in
 * FIRST_BOOST_COPY (DRAFT, pending Maker's approval). The cap is always read live; never hard-coded.
 */
import { erc20Abi, formatUnits, type PublicClient } from "viem";
import { launchpadAbi } from "./abi";
import { deployment } from "./chains";
import { creatorBuyMaxTokens, maxLaunchBuyQuoteIn, paramsFromQuotePrice } from "./curveMath";
import type { Address } from "./protocol";
import { ZERO_ADDRESS } from "./protocol";
import { readCreatorBuyMaxBps, readCreatorBuyQuote } from "./protocol-viem";

/** The approved draft says "0.77%"; `pct` is rendered from the live creatorBuyMaxBps so the copy can't drift. */
export const FIRST_BOOST_COPY = {
  label: "First BOOST (optional)",
  helper: (pct: string) => `BOOST your own rocket in the launch transaction, before anyone else. Up to ${pct} of supply.`,
  max: (amount: string, symbol: string, tokens: string, pct: string) => `Max ${amount} ${symbol} (${tokens} tokens, ${pct} of supply)`,
  estimate: (tokens: string, ticker: string, pct: string) => `≈ ${tokens} $${ticker} (${pct} of supply)`,
  overCap: (pct: string, max: string, symbol: string) => `Over the First BOOST cap: you can buy at most ${pct} of supply. Lower it to ${max} ${symbol} or less.`,
  balance: (have: string, symbol: string) => `Not enough ${symbol}: your balance is ${have} ${symbol}.`,
  invalid: "Enter an amount like 25 or 12.5.",
  connect: "Connect your wallet to check your balance.",
  loading: "Reading the live cap…",
  unavailable: "Couldn't read the live cap from the Launchpad. Leave this at 0 or try again.",
} as const;

/** bps → "0.77%" */
export const bpsToPct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

export interface FirstBoostLimits {
  quote: Address;         // resolved quote token (defaultQuote when the pair is address(0))
  symbol: string;
  decimals: number;
  capBps: number;         // Launchpad.creatorBuyMaxBps() (live)
  capTokens: bigint;      // FeeMath.creatorBuyMax(capBps)
  maxQuoteIn: bigint;     // largest spend that stays under the cap (curve math, confirmed by quoteCreatorBuy)
  quotePriceUsd: bigint;  // QuotePricer price the curve would launch at
}

export async function readFirstBoostLimits(pc: PublicClient, pair: Address, creatorTaxBps: number): Promise<FirstBoostLimits> {
  const launchpad = deployment().launchpad;
  const quote = pair !== ZERO_ADDRESS ? pair : await pc.readContract({ address: launchpad, abi: launchpadAbi, functionName: "defaultQuote" });
  const [capBps, symbol, decimals, probe] = await Promise.all([
    readCreatorBuyMaxBps(pc),
    pc.readContract({ address: quote, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: quote, abi: erc20Abi, functionName: "decimals" }),
    readCreatorBuyQuote(pc, quote, BigInt(0), creatorTaxBps).catch(() => null),
  ]);
  const capTokens = creatorBuyMaxTokens(capBps);
  let quotePriceUsd = probe?.quotePriceUsd ?? BigInt(0);
  if (!probe) quotePriceUsd = (await readCreatorBuyQuote(pc, quote, BigInt(1), creatorTaxBps)).quotePriceUsd;
  let maxQuoteIn = maxLaunchBuyQuoteIn(paramsFromQuotePrice(quotePriceUsd), capTokens, BigInt(creatorTaxBps));
  // The contract is authoritative: confirm the max with the view and back off if rounding differs.
  for (let i = 0; i < 3 && maxQuoteIn > BigInt(0); i++) {
    const q = await readCreatorBuyQuote(pc, quote, maxQuoteIn, creatorTaxBps);
    if (!q.exceedsCap) break;
    maxQuoteIn = (maxQuoteIn * BigInt(9999)) / BigInt(10000);
  }
  return { quote, symbol: String(symbol), decimals: Number(decimals), capBps, capTokens, maxQuoteIn, quotePriceUsd };
}

export async function readQuoteBalance(pc: PublicClient, token: Address, owner: Address) {
  return pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** Human amount → raw units; null if malformed or too many decimals. */
export function parseAmount(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!t) return BigInt(0);
  if (!/^\d*(\.\d*)?$/.test(t) || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w || "0") * BigInt(10) ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Compact display (e.g. 12,345.67 / 53.9M). Rounds DOWN for maxima so the shown max is always spendable. */
export function fmtAmount(raw: bigint, decimals: number, maxFrac = 4): string {
  const n = Number(formatUnits(raw, decimals));
  if (n >= 1e6) return `${(Math.floor((n / 1e6) * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
  const f = 10 ** maxFrac;
  return (Math.floor(n * f) / f).toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}
/** Raw → plain decimal string for the input (no grouping), rounded down. */
export function toInputString(raw: bigint, decimals: number, maxFrac = 6): string {
  const s = formatUnits(raw, decimals);
  const [w, f = ""] = s.split(".");
  const ff = f.slice(0, maxFrac).replace(/0+$/, "");
  return ff ? `${w}.${ff}` : w;
}

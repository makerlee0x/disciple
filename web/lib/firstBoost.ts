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
import { LAUNCH_ABI_SHAPE, LAUNCH_MODE_NAME, LaunchMode, effectiveCreatorBuyCapBps, type LaunchAbiShape } from "./launchAbi";

/** The approved draft says "0.77%"; `pct` is rendered from the live creatorBuyMaxBps so the copy can't drift. */
export const FIRST_BOOST_COPY = {
  label: "First BOOST (optional)",
  helper: (pct: string) => `BOOST your own rocket in the launch, before anyone else. Enter a $ amount, up to ${pct} of supply. Paid from your cash.`,
  max: (usd: string, tokens: string, pct: string) => `Max ${usd} (${tokens} tokens, ${pct} of supply)`,
  pays: (amount: string, symbol: string) => `≈ ${amount} ${symbol} at the live pair price`,
  estimate: (tokens: string, ticker: string, pct: string) => `≈ ${tokens} $${ticker} (${pct} of supply)`,
  modeCap: (mode: string, pct: string) => `${mode} launch: your First BOOST can be up to ${pct} of the coins.`,
  easyLock: "On Easy, your First BOOST stays locked until the rocket graduates. Coins you buy later are free to sell.",
  pveLogin: "Easy needs a verified email, Google or X login to BOOST. Yours is verified, so you're good to go.",
  pveLoginUnverified: "Easy needs a verified email, Google or X login to BOOST, and yours isn't verified yet. Sign in with one, or set First BOOST to 0.",
  // #99: /api/pve/attest verifies the Privy login and relays LoginGate.attest when you launch.
  pveLoginAttest: "Easy needs a verified email, Google or X login to BOOST. We'll check yours when you launch.",
  pveLoginUnknown: "Easy needs a verified email, Google or X login to BOOST. Sign in to check yours before your First BOOST.",
  overCap: (pct: string, maxUsd: string) => `Over the First BOOST cap: you can buy at most ${pct} of supply. Lower it to ${maxUsd} or less.`,
  balance: (haveUsd: string, symbol: string) => `Not enough ${symbol} for that First BOOST: you have ${haveUsd}.`, // legacy path only (no USDG router)
  // USDG-funded First BOOST (DiscipleRouter.launchWithUsdg): dollars only, the pair coin is never asked for.
  cash: (haveUsd: string) => `Not enough cash for that First BOOST: you have ${haveUsd}. Lower it or deposit more.`,
  cashBalance: (haveUsd: string) => `Cash ${haveUsd}`,
  paysCash: "Paid from your cash. We buy the pair coin for you in the same step.",
  privateOff: "First BOOST isn't available on private launches yet. Launch first, then BOOST like anyone else.",
  invalid: "Enter a $ amount like 25 or 12.5.",
  connect: "Connect your wallet to check your balance.",
  loading: "Reading the live cap…",
  unavailable: "Couldn't read the live cap from the Launchpad. Leave this at 0 or try again.",
} as const;

/** First BOOST is entered in $ (USD WAD, 18 dp) and converted with the live QuotePricer price (USD WAD per 1e18 raw). */
const WAD = BigInt(10) ** BigInt(18);
export const usdToQuoteRaw = (usdWad: bigint, quotePriceUsd: bigint) => (quotePriceUsd > BigInt(0) ? (usdWad * WAD) / quotePriceUsd : null);
export const quoteRawToUsdWad = (raw: bigint, quotePriceUsd: bigint) => (raw * quotePriceUsd) / WAD;
export const fmtUsdWad = (usdWad: bigint) => `$${(Math.floor(Number(formatUnits(usdWad, 18)) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** bps → "0.77%" */
export const bpsToPct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

export interface FirstBoostLimits {
  quote: Address;         // resolved quote token (defaultQuote when the pair is address(0))
  symbol: string;
  decimals: number;
  launchpadCapBps: number; // Launchpad.creatorBuyMaxBps() (live)
  capBps: number;         // effective cap = Launchpad.firstBoostMaxBps(mode) (lib/modeRules; Trench = launchpad cap)
  capBy: "launchpad" | "mode";
  mode: number;
  capTokens: bigint;      // TOTAL_SUPPLY * capBps / 1e4
  maxQuoteIn: bigint;     // largest spend that stays under the cap (curve math, confirmed by quoteCreatorBuy)
  quotePriceUsd: bigint;  // QuotePricer price the curve would launch at
}

export async function readFirstBoostLimits(pc: PublicClient, pair: Address, creatorTaxBps: number, mode: number = LaunchMode.TRENCH_WARFARE, shape: LaunchAbiShape = LAUNCH_ABI_SHAPE): Promise<FirstBoostLimits> {
  const launchpad = deployment().launchpad;
  const quote = pair !== ZERO_ADDRESS ? pair : await pc.readContract({ address: launchpad, abi: launchpadAbi, functionName: "defaultQuote" });
  const [launchpadCapBps, symbol, decimals, probe] = await Promise.all([
    readCreatorBuyMaxBps(pc),
    pc.readContract({ address: quote, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: quote, abi: erc20Abi, functionName: "decimals" }),
    readCreatorBuyQuote(pc, quote, BigInt(0), creatorTaxBps, mode).catch(() => null),
  ]);
  const eff = effectiveCreatorBuyCapBps(launchpadCapBps, mode, shape);
  const capBps = eff.bps;
  const capTokens = creatorBuyMaxTokens(capBps);
  let quotePriceUsd = probe?.quotePriceUsd ?? BigInt(0);
  if (!probe) quotePriceUsd = (await readCreatorBuyQuote(pc, quote, BigInt(1), creatorTaxBps, mode)).quotePriceUsd;
  let maxQuoteIn = maxLaunchBuyQuoteIn(paramsFromQuotePrice(quotePriceUsd), capTokens, BigInt(creatorTaxBps));
  // The contract is authoritative: confirm the max with the view and back off if rounding differs.
  for (let i = 0; i < 3 && maxQuoteIn > BigInt(0); i++) {
    const q = await readCreatorBuyQuote(pc, quote, maxQuoteIn, creatorTaxBps, mode);
    if (!q.exceedsCap && q.tokensOut <= capTokens) break; // mode-aware quote: exceedsCap = over firstBoostMaxBps(mode)
    maxQuoteIn = (maxQuoteIn * BigInt(9999)) / BigInt(10000);
  }
  return { quote, symbol: String(symbol), decimals: Number(decimals), launchpadCapBps, capBps, capBy: eff.by, mode, capTokens, maxQuoteIn, quotePriceUsd };
}

export const modeName = (m: number) => LAUNCH_MODE_NAME[m] ?? `mode ${m}`;

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

/** Shared helpers for the claim flows: quote metadata (symbol/decimals/USD), formatting, revert decoding, indexer. */
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, formatUnits, parseAbi, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { bondingCurveAbi, feeRouterAbi, launchpadAbi, tokenAbi } from "../abi";
import { curveRedeployAbi, depositNotifierAbi, feeRouterRedeployAbi } from "../abi/redeploy";
import { deployment } from "../chains";

const pricerAbi = parseAbi(["function quotePriceUsd(address quote) view returns (uint256)"]);
export type Asset = { address: Address; symbol: string; decimals: number; /** USD per 1 whole unit (live QuotePricer, else null) */ usd: number | null };

const metaCache = new Map<string, Promise<Asset>>();
/** symbol + decimals + live USD (QuotePricer.quotePriceUsd: USD WAD per 1e18 raw ⇒ decimal-agnostic). Cached. */
export function assetMeta(pc: PublicClient, address: Address): Promise<Asset> {
  const k = address.toLowerCase();
  let p = metaCache.get(k);
  if (!p) {
    p = (async () => {
      const [symbol, decimals, px] = await Promise.all([
        pc.readContract({ address, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
        pc.readContract({ address, abi: tokenAbi, functionName: "decimals" }).then(Number).catch(() => 18),
        deployment().quotePricer !== "0x0000000000000000000000000000000000000000"
          ? pc.readContract({ address: deployment().quotePricer, abi: pricerAbi, functionName: "quotePriceUsd", args: [address] }).catch(() => BigInt(0))
          : Promise.resolve(BigInt(0)),
      ]);
      // quotePriceUsd is USD WAD per 1e18 raw units ⇒ USD per whole unit = px/1e18 × 10^decimals/1e18
      const usd = px > BigInt(0) ? (Number(px) / 1e18) * (10 ** decimals / 1e18) : null;
      return { address, symbol: String(symbol), decimals, usd };
    })();
    metaCache.set(k, p);
  }
  return p;
}

/** "12.34 STRATEGY" with sensible precision (never scientific for normal sizes). */
export function fmtAmount(raw: bigint, a: Pick<Asset, "decimals" | "symbol">, maxFrac = 4): string {
  const n = Number(formatUnits(raw, a.decimals));
  const s = n === 0 ? "0" : n < 10 ** -maxFrac ? `<${(10 ** -maxFrac).toFixed(maxFrac)}` : n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : maxFrac });
  return `${s} ${a.symbol}`;
}
export function toUsd(raw: bigint, a: Asset): number | null {
  return a.usd == null ? null : Number(formatUnits(raw, a.decimals)) * a.usd;
}
export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: v < 100 ? 2 : 0 });
}

const ERR_ABIS: Abi[] = [feeRouterAbi as Abi, depositNotifierAbi as Abi, curveRedeployAbi as Abi, feeRouterRedeployAbi as Abi, launchpadAbi as Abi, bondingCurveAbi as Abi];
/** Custom error name + args from any viem/AA error (simulation or on-chain revert). */
export function revertOf(e: unknown): { name: string; args: readonly unknown[] } | null {
  // duck-typed (AAError.extra.revertData): instanceof breaks across duplicated module instances
  const data = (e as { extra?: { revertData?: unknown } } | null)?.extra?.revertData as Hex | undefined;
  if (data) for (const abi of ERR_ABIS) { try { const r = decodeErrorResult({ abi, data }); return { name: r.errorName, args: (r.args ?? []) as readonly unknown[] }; } catch { /* next */ } }
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data?.errorName) return { name: rev.data.errorName, args: (rev.data.args ?? []) as readonly unknown[] };
    const raw = (rev as unknown as { raw?: Hex } | null)?.raw;
    if (raw) for (const abi of ERR_ABIS) { try { const r = decodeErrorResult({ abi, data: raw }); return { name: r.errorName, args: (r.args ?? []) as readonly unknown[] }; } catch { /* next */ } }
  }
  return null;
}

/** Short, plain error copy for claim/deposit flows. */
export function claimErrorText(e: unknown): string {
  const r = revertOf(e);
  switch (r?.name) {
    case "NothingToClaim": case "ZeroAmount": return "Nothing to claim yet.";
    case "NothingEscrowed": return "Nothing to withdraw yet.";
    case "Locked": return `Still locked until ${new Date(Number(r.args[1]) * 1000).toLocaleString()}.`;
    case "BelowMinimum": return "Deposit is below the minimum.";
  }
  const m = (e as Error)?.message ?? String(e);
  if (/user rejected|denied/i.test(m)) return "Cancelled.";
  return m.split("\n")[0].slice(0, 120);
}

/** Optional indexer (indexer/ REST). Unset ⇒ every read falls back to RPC logs. */
export const INDEXER_URL = (process.env.NEXT_PUBLIC_INDEXER_URL || "").replace(/\/+$/, "");
export async function indexerGet<T>(path: string, timeoutMs = 4000): Promise<T | null> {
  if (!INDEXER_URL || !/^https?:\/\//.test(INDEXER_URL)) return null;
  try {
    const r = await fetch(INDEXER_URL + path, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
export const lc = (a: string) => a.toLowerCase();

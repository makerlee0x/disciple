/**
 * Server-side chain reads with a second node (maker 2026-11-20: the $SPACE page went blank while RH_RECEIPT_RPC_URL was
 * set, because only the /api/rpc proxy and the relay's receipt wait ever used it; every other server read, including
 * the trades indexer, coin stats and the crons, hit the one public RPC).
 * Order: the public RPC first (short timeout), then the chain's receipt node (RH_RECEIPT_RPC_URL on mainnet,
 * RHT_RECEIPT_RPC_URL on testnet). viem's fallback stops on a contract revert, so a real revert never retries.
 * In a browser the receipt URL is never visible (not NEXT_PUBLIC), so this is the plain public RPC there.
 */
import { fallback, http, type HttpTransportConfig, type Transport } from "viem";
import { ACTIVE_CHAIN } from "../chains";
import { receiptRpcUrl } from "../server/chainRpcEnv";

/** The chain's read URLs, primary first, de-duplicated. */
export function serverReadUrls(primary: string = ACTIVE_CHAIN.rpcUrls.default.http[0], env: Record<string, string | undefined> = process.env, chainId: number = ACTIVE_CHAIN.id): string[] {
  const fb = typeof window === "undefined" ? receiptRpcUrl(env, chainId) : undefined;
  return fb && fb !== primary ? [primary, fb] : [primary];
}

/** http() over each read URL, falling over to the next on a timeout / network / 5xx / rate-limit error. */
export function serverReadTransport(o: HttpTransportConfig & { primary?: string; primaryTimeoutMs?: number } = {}): Transport {
  const { primary, primaryTimeoutMs, ...cfg } = o;
  const urls = serverReadUrls(primary || undefined);
  if (urls.length === 1) return http(urls[0], primaryTimeoutMs ? { ...cfg, timeout: primaryTimeoutMs } : cfg);
  return fallback([
    http(urls[0], { ...cfg, timeout: primaryTimeoutMs ?? Math.min(cfg.timeout ?? 4_000, 4_000) }),
    ...urls.slice(1).map((u) => http(u, cfg)),
  ], { rank: false, retryCount: cfg.retryCount ?? 1 });
}

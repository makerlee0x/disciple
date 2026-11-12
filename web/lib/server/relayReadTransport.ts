import "server-only";
import { fallback, http, type Transport } from "viem";

// JSON-RPC batching only: same individual methods/params/block tags and caller semantics.
// In particular this is NOT an EVM multicall (which would change msg.sender for eth_call).
const READS = ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getTransactionCount", "eth_gasPrice", "eth_getBalance", "eth_getTransactionReceipt"];
export function relayReadTransport(timeout: number, retryCount: number, url?: string): Transport {
  const options = { fetchOptions: { keepalive: true }, timeout, retryCount };
  // An incompatible batch endpoint must not remove the working scalar path. viem's
  // fallback stops on execution reverts; a failed simulation cannot become a success.
  // No write method is eligible for batching. No endpoint/provider is changed.
  return fallback([
    http(url, { ...options, batch: { wait: 0, batchSize: 32 }, methods: { include: READS } }),
    http(url, options),
  ], { rank: false, retryCount: 0 });
}

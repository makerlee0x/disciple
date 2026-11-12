/**
 * The JSON-RPC methods our same-origin read proxy (/api/rpc) forwards to the RH RPC: read-only state, chain, fee and
 * gas-estimate methods the app calls BEFORE it sends a trade. Anything that sends or signs (eth_sendRawTransaction,
 * eth_sendRawTransactionSync, eth_sendTransaction, eth_sign*, personal_*, debug_*, …) is never forwarded.
 * Pure: shared by the client transport (lib/rpc/readTransport) and the server (lib/server/rpcProxy).
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_call", "eth_getBalance", "eth_blockNumber", "eth_chainId", "eth_getCode", "eth_getTransactionCount",
  "eth_estimateGas",
  // fees: mav2.fetchFees → estimateFeesPerGas (latest block header + priority fee) when the fee cache is cold
  "eth_getBlockByNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas",
]);
/** A params list the proxy accepts for `method` (eth_getBlockByNumber: header only, never full transactions). */
export function readParamsOk(method: string, params: unknown): boolean {
  if (params !== undefined && !Array.isArray(params)) return false;
  if (method === "eth_getBlockByNumber") return Array.isArray(params) && params[1] !== true;
  return true;
}

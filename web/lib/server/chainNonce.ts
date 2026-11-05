/** Internal keeper sends only; independent of the removed public fast relay. */
import type { Address, PublicClient } from "viem";
import { SharedNonceCursor, sendWithCursor } from "./relayerNonce";
import { kv } from "./kv";
export const chainNonceKey = (chainId: number, address: string) => `relayer:nonce:${chainId}:${address.toLowerCase()}`;
const cursors = new Map<string, SharedNonceCursor>();
export async function sendWithChainNonce<T>(pc: PublicClient, address: Address, send: (nonce: number) => Promise<T>): Promise<T> {
  const chainId = await pc.getChainId();
  if (!pc.chain || chainId !== pc.chain.id) throw new Error("keeper_rpc_chain_mismatch");
  const key = chainNonceKey(chainId, address), holes = `${key}:holes`;
  let cursor = cursors.get(key);
  if (!cursor) {
    // Same namespace and TTL as the existing shared allocator; counters are separated by actual RPC chain.
    cursor = new SharedNonceCursor({
      alloc: (floor) => kv().nonceAlloc(key, holes, floor, 3600),
      release: (n) => kv().nonceRelease(key, holes, n, 3600),
      claim: (tag, ttl) => kv().setNX(`${key}:${tag}`, "1", ttl),
    }, () => pc.getTransactionCount({ address, blockTag: "pending" }));
    cursors.set(key, cursor);
  }
  return sendWithCursor(cursor, send, 3);
}

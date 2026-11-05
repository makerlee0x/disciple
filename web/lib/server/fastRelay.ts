import "server-only";
/** F-02: public userOp relaying is disabled. No handleOps signer/broadcaster remains. */
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "../chains";
import type { UserOp } from "../aa/core";
import type { RelayConfirmed } from "../aa/relayTypes";
import { relayerKey } from "./relayer";
import { kv } from "./kv";
import { RelayerNonceCursor, SharedNonceCursor, sendWithCursor, type NonceCursor, type NonceStore } from "./relayerNonce";

export function kvNonceStore(address: string, chainId = robinhoodTestnet.id): NonceStore {
  const k = `relayer:nonce:${chainId}:${address.toLowerCase()}`, h = `${k}:holes`;
  return {
    alloc: (floor) => kv().nonceAlloc(k, h, floor, 3600),
    release: (n) => kv().nonceRelease(k, h, n, 3600),
    claim: (tag, ttl) => kv().setNX(`${k}:${tag}`, "1", ttl),
  };
}
let adminCursor: NonceCursor | undefined;
/** Non-AA protocol jobs only (pricer maintenance / attest / test-token mint); never exposed by /api/bundler. */
export async function sendWithRelayerNonce<T>(send: (nonce: number) => Promise<T>): Promise<T> {
  if (!adminCursor) {
    const account = privateKeyToAccount(relayerKey());
    const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
    const pending = () => pc.getTransactionCount({ address: account.address, blockTag: "pending" });
    adminCursor = process.env.RELAYER_NONCE_SHARED === "0" ? new RelayerNonceCursor(pending) : new SharedNonceCursor(kvNonceStore(account.address), pending);
  }
  return sendWithCursor(adminCursor, send, 3);
}
export type StandardRelayer = { address: Hex; send(...args: unknown[]): Promise<Hex> };
/** Fail closed for stale internal callers, before reading a key or contacting any RPC. */
export async function standardRelayer(): Promise<StandardRelayer> { throw new Error("protocol relay disabled"); }
export async function sendUserOperationSync(_op: UserOp, _onPending?: unknown, _beforeSend?: () => Promise<void>): Promise<RelayConfirmed> {
  throw new Error("protocol relay disabled");
}
export async function warmRelay(_sender?: string): Promise<never> { throw new Error("protocol relay disabled"); }

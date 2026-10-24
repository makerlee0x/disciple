/**
 * Relay op identity across a failed send (data retest Oct 23, Seth's "simulation failed, then the trade landed").
 * Once the self-bundler has SIGNED the handleOps tx, both ids are fixed: the userOp hash (from the op itself) and the
 * bundle tx hash (keccak of the signed raw tx). Any error after that point (receipt timeout, lost sync answer, reverted
 * bundle) may still have landed, so the relay returns both ids in JSON-RPC error.data and the client keeps them, looks
 * the op up on-chain and shows the right id. Never an id from an earlier op: the client only trusts a hash that matches
 * the op it just signed.
 * Shared by server (lib/server/fastRelay, selfBundler, /api/bundler) and client (lib/aa/mav2). No server-only imports.
 */
import type { Hex } from "viem";

const HASH = /^0x[0-9a-fA-F]{64}$/;
export type RelayOpRef = { userOpHash: Hex; txHash?: Hex; broadcast: true };

/** A relay error raised AFTER the bundle tx was signed/sent: carries the op's ids (→ /api/bundler error.data). */
export class RelayBroadcastError extends Error {
  readonly data: RelayOpRef;
  constructor(msg: string, userOpHash: Hex, txHash?: Hex) {
    super(`${msg} [userOp ${userOpHash}]`);
    this.name = "RelayBroadcastError";
    this.data = { userOpHash, ...(txHash ? { txHash } : {}), broadcast: true };
  }
}
/** Wrap any post-broadcast failure (keeps the original first line, adds the ids). Idempotent. */
export function broadcastError(e: unknown, userOpHash: Hex, txHash?: Hex): RelayBroadcastError {
  if (e instanceof RelayBroadcastError) return e;
  const m = (e as { shortMessage?: string })?.shortMessage || (e as Error)?.message || String(e);
  return new RelayBroadcastError(m.split("\n")[0].slice(0, 200), userOpHash, txHash);
}

/**
 * The op ids a relay error reports (error.data object, else the "[userOp 0x…]" tag in the message, also what viem's
 * RpcRequestError keeps in .details / .data). Undefined when the relay never got as far as broadcasting.
 */
export function relayOpRef(err: unknown): RelayOpRef | undefined {
  let ref: RelayOpRef | undefined;
  const look = (x: unknown) => {
    if (!x || typeof x !== "object") return false;
    const d = (x as { data?: unknown }).data;
    if (d && typeof d === "object" && HASH.test(String((d as { userOpHash?: unknown }).userOpHash))) {
      const tx = (d as { txHash?: unknown }).txHash;
      ref = { userOpHash: (d as { userOpHash: Hex }).userOpHash, ...(typeof tx === "string" && HASH.test(tx) ? { txHash: tx as Hex } : {}), broadcast: true };
      return true;
    }
    return false;
  };
  if (look(err)) return ref;
  (err as { walk?: (f: (x: unknown) => boolean) => unknown })?.walk?.(look);
  if (ref) return ref;
  const text = [(err as { message?: unknown })?.message, (err as { details?: unknown })?.details].filter((s) => typeof s === "string").join(" ");
  const m = /\[userOp (0x[0-9a-fA-F]{64})\]/.exec(text);
  if (!m) return undefined;
  const tx = /relayer tx (0x[0-9a-fA-F]{64})/.exec(text);
  return { userOpHash: m[1] as Hex, ...(tx ? { txHash: tx[1] as Hex } : {}), broadcast: true };
}

/**
 * The ids to keep for an op the client just signed (`local` = its own userOpHash, authoritative). The relay's bundle tx
 * hash is kept only when the relay reports the SAME op; a different hash is stale / another op's and is dropped.
 * No local hash ⇒ the relay's ids as reported.
 */
export function keptOpRef(local: Hex | undefined, ref: RelayOpRef | undefined): { userOpHash?: Hex; txHash?: Hex } {
  if (!local) return ref ? { userOpHash: ref.userOpHash, txHash: ref.txHash } : {};
  if (ref && ref.userOpHash.toLowerCase() === local.toLowerCase()) return { userOpHash: local, txHash: ref.txHash };
  return { userOpHash: local };
}
/** "0x1234…abcd" for status lines. */
export const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/** The relay's bundle tx itself reverted (handleOps rejected the op at inclusion): the op did NOT execute. */
export const BUNDLE_REVERTED = /relayer tx 0x[0-9a-fA-F]{64} reverted/i;
/** Status-line copy for a sent op whose outcome is still unknown / whose bundle was rejected (op id shown short). */
export const sentPendingMsg = (h?: string) => `Trade sent — still confirming on-chain${h ? ` (op ${shortHash(h)})` : ""}. Check your balance in a moment.`;
export const bundleRejectedMsg = (h?: string) => `Trade didn't go through: the relay rejected it${h ? ` (op ${shortHash(h)})` : ""}. Try again.`;

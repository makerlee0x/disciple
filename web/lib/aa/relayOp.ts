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
/** The relay's bundle tx itself reverted (handleOps rejected the op at inclusion): the op did NOT execute. */
export const BUNDLE_REVERTED = /relayer tx 0x[0-9a-fA-F]{64} reverted/i;
/**
 * Player-facing copy (approved by lee 2026-10-24). NO ids or chain/relay wording here: the op id and bundle tx hash
 * live on AAError.extra and in the console (logRelayOp), never in a toast / inline error.
 */
export const PENDING_MSG = "Still confirming. Check back in a moment.";
export const REJECTED_MSG = "That didn't go through. Try again.";
/** A connection problem before anything was sent (viem HttpRequestError / TimeoutError / fetch failure on a read). */
export const NETWORK_MSG = "Connection hiccup, nothing was sent. Try again.";
/** viem / fetch transport failures ("HTTP request failed.", "The request took too long to respond.", "Failed to fetch"). */
export const TRANSPORT_ERR = /HTTP request failed|request took too long|failed to fetch|fetch failed|networkerror|load failed|ERR_\w+|socket hang up|ECONNRESET/i;
export function isTransportError(e: unknown): boolean {
  const x = e as { name?: string; shortMessage?: string; message?: string; walk?: (f: (y: unknown) => boolean) => unknown } | null;
  if (!x) return false;
  if (x.name === "HttpRequestError" || x.name === "TimeoutError") return true;
  if (typeof x.walk === "function" && x.walk((y) => { const n = (y as { name?: string })?.name; return n === "HttpRequestError" || n === "TimeoutError"; })) return true;
  return TRANSPORT_ERR.test(`${x.shortMessage ?? ""} ${String(x.message ?? e).split("\n")[0]}`);
}
export const NO_PRICE_MSG = "Couldn't get a price right now. Try again.";
/** Console-only trace of a sent op's ids (support/debugging); never shown to players. */
export function logRelayOp(state: "pending" | "rejected", ids: { userOpHash?: string; txHash?: string }, relayError?: string) {
  if (typeof console !== "undefined") console.warn(`[disciple] trade ${state}`, { userOpHash: ids.userOpHash, txHash: ids.txHash, ...(relayError ? { relayError } : {}) });
}
/**
 * Player-copy guard: text that carries ids/hex, a function or contract error name, or chain/relay plumbing words.
 * Display layers (friendlyError fallback, lib/playerError) swap such text for REJECTED_MSG and log the raw text.
 */
export const JARGON = /0x[0-9a-fA-F]{3,}|\b(?:user ?op(?:eration)?s?|txs?|transaction reverted|relay(?:er|ed)?|on-?chain|simulat\w*|bundl\w*|AA\d{2}|v4|rpc|eth_\w+|entry ?point|paymaster|nonce|reverted|execution reverted|calldata|selector|abi|https?|request failed|fetch)\b|\w+\.\w+\(\)|\b[a-z]+[A-Z]\w*\(/i;
const RAW_NAME = /^\s*[A-Za-z][A-Za-z0-9_]*[a-z0-9][A-Z][A-Za-z0-9_]*\s*$/;   // one camel-case token: "WalletCap", "ERC20InsufficientBalance"
/** The text players may see: `m` when it is plain, else REJECTED_MSG (raw text → console). */
export function plainText(m: string | undefined | null, what = "error", detail: Record<string, unknown> = {}): string {
  const t = String(m ?? "").split("\n")[0].trim();
  if (t && !JARGON.test(t) && !RAW_NAME.test(t)) return t;
  logTradeError(`${what} (reworded for players)`, { message: String(m ?? "").slice(0, 300), ...detail });
  return REJECTED_MSG;
}
/** Console-only detail for a plain-worded trade error (ids, raw relay text, revert selector); never shown to players. */
export function logTradeError(what: string, detail: Record<string, unknown>) {
  if (typeof console !== "undefined") console.warn(`[disciple] ${what}`, detail);
}

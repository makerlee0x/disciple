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
export const NO_PRICE_MSG = "Couldn't get a price right now. Try again.";
/** Console-only trace of a sent op's ids (support/debugging); never shown to players. */
export function logRelayOp(state: "pending" | "rejected", ids: { userOpHash?: string; txHash?: string }) {
  if (typeof console !== "undefined") console.warn(`[disciple] trade ${state}`, { userOpHash: ids.userOpHash, txHash: ids.txHash });
}
/**
 * Player-copy guard: text that carries ids/hex, a function or contract error name, or chain/relay plumbing words.
 * Display layers (friendlyError fallback, lib/playerError) swap such text for REJECTED_MSG and log the raw text.
 */
export const JARGON = /0x[0-9a-fA-F]{3,}|\b(?:user ?op(?:eration)?s?|txs?|transaction reverted|relay(?:er|ed)?|on-?chain|simulat\w*|bundl\w*|AA\d{2}|v4|rpc|eth_\w+|entry ?point|paymaster|nonce|reverted|execution reverted|calldata|selector|abi)\b|\w+\.\w+\(\)|\b[a-z]+[A-Z]\w*\(/i;
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

/* ---------- rapid-tap (SITE): rate limit + spend limit ---------- */
/** Copy pending lee + BRAND approval (placeholders). Plain words only: details go to console.warn("[disciple] …"). */
export const SLOW_DOWN_MSG = "Slow down";
export const SPEND_LIMIT_MSG = "Spend limit reached";
/** Typed trade error codes GAME maps to its own copy (ProtocolError.code / TradeResult.errorCode). */
export type TradeErrorCode = "rate_limited" | "spend_limit" | "pending_unknown";
/**
 * AUDIT (#141 review): a receipt / relay timeout does NOT mean the trade failed: it may still land. The trade layer
 * answers 'pending_unknown', keeps the reservation held and watches the op until it lands or is definitely dropped.
 * Copy pending lee approval (placeholder). Plain words only: ids / nonce go to console.warn("[disciple] …").
 */
export const PENDING_UNKNOWN_MSG = "Still confirming your last trade…";
/** The op ids an ambiguous send keeps (AAError("Timeout").extra): what the background watcher looks up. */
export type UnknownOpRef = { userOpHash?: Hex; txHash?: Hex; nonce?: bigint; sender?: string };
/**
 * Is this send error an op whose fate is unknown (receipt wait timed out, relay timed out, lost answer after
 * broadcast)? Duck-typed (AAError can come from a second module instance). Returns the ids to watch, else null.
 */
export function unknownOpOf(e: unknown): UnknownOpRef | null {
  const x = e as { code?: unknown; constructor?: { name?: string }; extra?: Record<string, unknown> } | null;
  // AAError("Timeout", …, extra) — `extra` is an own field of AAError (ProtocolError("Timeout") has none); class names
  // can be minified in production, so the name is only a second signal
  if (!x || typeof x !== "object" || x.code !== "Timeout" || !("extra" in x || x.constructor?.name === "AAError")) return null;
  const ex = x.extra ?? {};
  // FLOW #141: a definite relay answer (revert payload, no `unclear` flag) is never unknown, whatever the code says
  if (ex.unclear !== true && ex.revert !== undefined && ex.revert !== null) return null;
  const h = (v: unknown) => (typeof v === "string" && HASH.test(v) ? (v as Hex) : undefined);
  // only a bigint is the EntryPoint v0.7 op nonce (SITE mav2; FLOW #141 RelayTimeoutExtra.nonce). The relayer EOA nonce
  // of the handleOps tx is FLOW's `relayNonce` (a number): never the op's nonce (lib/trade/pendingOps keeps it apart)
  const nonce = typeof ex.nonce === "bigint" ? ex.nonce : undefined;
  return { userOpHash: h(ex.userOpHash), txHash: h(ex.txHash), nonce, sender: typeof ex.sender === "string" ? ex.sender : undefined };
}
/** JSON-RPC code /api/bundler returns with HTTP 429 (lib/server/limits via app/api/bundler/route.ts). */
export const RATE_LIMIT_RPC_CODE = -32005;
/**
 * Is this relay answer a rate limit? HTTP 429, or JSON-RPC error -32005 (some proxies drop the status), or a viem
 * HttpRequestError with status 429 (standard path). retryAfterMs: the Retry-After header (seconds or an HTTP date),
 * else the "retry in Ns" hint in the message; undefined when neither is there.
 */
export function rateLimitOf(a: { status?: number; code?: number; message?: string; retryAfter?: string | null; now?: number }): { retryAfterMs?: number } | null {
  const hit = a.status === 429 || a.code === RATE_LIMIT_RPC_CODE || /\b429\b|rate[ -]?limit/i.test(a.message ?? "");
  if (!hit) return null;
  return { retryAfterMs: retryAfterMs(a.retryAfter, a.message, a.now) };
}
export function retryAfterMs(header?: string | null, message?: string, now = Date.now()): number | undefined {
  const h = (header ?? "").trim();
  if (h) {
    if (/^\d+(\.\d+)?$/.test(h)) return Math.round(Number(h) * 1000);
    const t = Date.parse(h); if (Number.isFinite(t)) return Math.max(0, t - now);
  }
  const m = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(message ?? "");
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}
/** Find a 429 anywhere in a thrown error chain (viem HttpRequestError .status / .headers, RpcRequestError .code). */
export function rateLimitFromError(e: unknown): { retryAfterMs?: number } | null {
  for (let x = e as Record<string, unknown> | undefined, i = 0; x && i < 10; x = x.cause as Record<string, unknown> | undefined, i++) {
    const hdr = x.headers as { get?: (k: string) => string | null } | undefined;
    const r = rateLimitOf({ status: typeof x.status === "number" ? x.status : undefined, code: typeof x.code === "number" ? x.code : undefined,
      message: [x.details, x.shortMessage, x.message].filter((s) => typeof s === "string").join(" "), retryAfter: typeof hdr?.get === "function" ? hdr.get("retry-after") : undefined });
    if (r) return r;
  }
  return null;
}

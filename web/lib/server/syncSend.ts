/**
 * Relayer tx send with the receipt on the same call (EIP-7966 eth_sendRawTransactionSync). Pure: transports and the
 * receipt reader are injected, so scripts/test-sync-send.mts covers every branch without RPC.
 *
 * Order: RHT_SEQUENCER_URL (send-only endpoint, ≈0.6 s p50 ahead of the public RPC's view) → public RPC.
 *  - unset sequencer ⇒ exactly today's call: eth_sendRawTransactionSync [raw] on the public RPC (no timeout param).
 *  - timeout PARAM FORMAT differs per endpoint: RH's sequencer rejects a hex string (-32602 "cannot unmarshal string
 *    into Go value of type uint64") and needs a JSON number ([raw, 2000]); the public RPC was seen rejecting the
 *    number. Each endpoint starts with its configured format and flips number⇄hex once on a -32602 unmarshal error
 *    (memoized on the Endpoint object).
 *  - sequencer network / 5xx / unknown error ⇒ resend the SAME signed tx to the public RPC (idempotent: "already
 *    known" ⇒ it's in, wait for it).
 *  - timeout (EIP-7966 code 4, or "timeout"/"timed out") or "already known" ⇒ onPending({ txHash }) and wait for the
 *    receipt server-side (pollMs, default 50 ms ≈ ⅓ block). The client never polls.
 *  - nonce errors are rethrown (fastRelay resyncs its cursor and re-signs); every thrown error carries `txHash`.
 */
import type { Hex } from "viem";
import type { RelayReceipt, RelayVia } from "../aa/relayTypes";

export type RpcFn = (method: string, params: unknown[]) => Promise<unknown>;
export type TimeoutFormat = "number" | "hex" | "none";
export type Endpoint = { name: "sequencer" | "rpc"; rpc: RpcFn; timeoutFormat: TimeoutFormat; syncSupported?: boolean };
export type RpcErr = Error & { code?: number; data?: unknown; txHash?: Hex };

export const DEFAULT_SYNC_TIMEOUT_MS = 2000;

export const isUnmarshalErr = (e: RpcErr) => e.code === -32602 && /unmarshal|invalid argument|cannot|uint64|hex/i.test(e.message);
export const isNotSupported = (e: RpcErr) => e.code === -32601 || /method not found|not supported|does not exist/i.test(e.message);
export const isTimeoutErr = (e: RpcErr) => e.code === 4 || /timed? ?out|timeout|deadline/i.test(e.message);
export const isAlreadyKnown = (e: RpcErr) => /already known|known transaction|already imported/i.test(e.message);
export const isNonceErr = (e: RpcErr) => /nonce too low|nonce too high|invalid nonce|nonce gap/i.test(e.message) || e.code === 6;
/** Definitive rejections from the node (the tx is NOT in): don't resend elsewhere, surface them. */
export const isRejected = (e: RpcErr) => isNonceErr(e) || /insufficient funds|intrinsic gas|fee cap|underpriced|max fee per gas less than block base fee|rlp|typed transaction/i.test(e.message);

function params(raw: Hex, fmt: TimeoutFormat, timeoutMs: number): unknown[] {
  return fmt === "number" ? [raw, timeoutMs] : fmt === "hex" ? [raw, `0x${timeoutMs.toString(16)}`] : [raw];
}

async function callSync(ep: Endpoint, raw: Hex, timeoutMs: number): Promise<RelayReceipt> {
  try { return (await ep.rpc("eth_sendRawTransactionSync", params(raw, ep.timeoutFormat, timeoutMs))) as RelayReceipt; }
  catch (e) {
    if (!isUnmarshalErr(e as RpcErr) || ep.timeoutFormat === "none") throw e;
    ep.timeoutFormat = ep.timeoutFormat === "number" ? "hex" : "number";   // memoized for the next send
    return (await ep.rpc("eth_sendRawTransactionSync", params(raw, ep.timeoutFormat, timeoutMs))) as RelayReceipt;
  }
}

export type SyncSendResult = { rc: RelayReceipt; via: RelayVia; sendMs: number; minedMs: number; pending: boolean };
export type SyncSendOpts = {
  sequencer?: Endpoint; rpc: Endpoint; timeoutMs?: number;
  getReceipt: (h: Hex) => Promise<RelayReceipt | null>;
  onPending?: (p: { txHash: Hex; reason: "sync-timeout" | "sync-error" | "sync-unsupported" }) => void;
  pollMs?: number; maxWaitMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
};

export async function syncSend(raw: Hex, txHash: Hex, o: SyncSendOpts): Promise<SyncSendResult> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const t0 = now();
  const tag = (e: unknown) => Object.assign(e as RpcErr, { txHash });
  let reason: "sync-timeout" | "sync-error" | "sync-unsupported" | undefined;
  for (const ep of [o.sequencer, o.rpc]) {
    if (!ep) continue;
    if (ep.syncSupported === false) {
      if (ep === o.rpc) {   // plain send, then wait (old -32601 fallback)
        try { await ep.rpc("eth_sendRawTransaction", [raw]); } catch (e) { if (!isAlreadyKnown(e as RpcErr)) throw tag(e); }
        reason = "sync-unsupported"; break;
      }
      continue;
    }
    try {
      const rc = await callSync(ep, raw, timeoutMs);
      ep.syncSupported = true;
      return { rc, via: ep.name === "sequencer" ? "sequencer-sync" : "rpc-sync", sendMs: now() - t0, minedMs: 0, pending: false };
    } catch (e) {
      const err = e as RpcErr;
      if (ep === o.sequencer && (err.code === -32099 || err.code === -32098)) continue;   // transport: resend via the RPC
      if (isTimeoutErr(err) || isAlreadyKnown(err)) { reason = "sync-timeout"; break; }
      if (isNotSupported(err)) { ep.syncSupported = false; if (ep === o.rpc) { try { await ep.rpc("eth_sendRawTransaction", [raw]); } catch (e2) { if (!isAlreadyKnown(e2 as RpcErr)) throw tag(e2); } reason = "sync-unsupported"; break; } continue; }
      if (isRejected(err)) throw tag(err);
      if (ep === o.sequencer) continue;   // network / 5xx / unknown on the sequencer ⇒ same raw tx via the public RPC
      throw tag(err);
    }
  }
  const t1 = now();
  o.onPending?.({ txHash, reason: reason ?? "sync-error" });
  const deadline = t1 + (o.maxWaitMs ?? 20_000);
  for (;;) {
    const rc = await o.getReceipt(txHash).catch(() => null);
    if (rc) return { rc, via: "rpc-wait", sendMs: t1 - t0, minedMs: now() - t1, pending: true };
    if (now() > deadline) throw tag(Object.assign(new Error(`relayer tx ${txHash} not confirmed (timeout)`), { code: -32000 }));
    await sleep(o.pollMs ?? 50);
  }
}

/** JSON-RPC over fetch (keep-alive), errors as RpcErr { code, message, data }. */
export function jsonRpc(url: string, abortMs = 10_000): RpcFn {
  let id = 0;
  return async (method, p) => {
    let r: Response;
    try { r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, keepalive: true, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: p }), signal: AbortSignal.timeout(abortMs) }); }
    catch (e) { throw Object.assign(new Error(`network: ${(e as Error).message}`), { code: -32099 }); }
    const j = await r.json().catch(() => null) as { result?: unknown; error?: { code: number; message: string; data?: unknown } } | null;
    if (!j) throw Object.assign(new Error(`HTTP ${r.status} unreadable`), { code: -32098 });
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
}

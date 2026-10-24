/**
 * Relayer tx send with the receipt on the same call (EIP-7966 eth_sendRawTransactionSync). Pure: transports and the
 * receipt reader are injected, so scripts/test-sync-send.mts covers every branch without RPC.
 *
 * Measured live (10:06 CT, warm connection): eth_sendRawTransactionSync [rawTx] to the RH sequencer endpoint returned
 * the full receipt (status, blockNumber, logs) in 160.88 ms; the public RPC showed the tx 643–745 ms later. Cold TLS
 * adds 260–660 ms ⇒ keep the connection warm (fastRelay.warmSequencer + fetch keep-alive).
 *
 * Rules:
 *  1. eth_sendRawTransactionSync with [rawTx] ONLY. Never a timeout param (two live tests got opposite -32602 parse
 *     errors for a hex vs a number timeout).
 *  2. -32602 / -32601 ⇒ the tx was NOT accepted: eth_sendRawTransaction with the SAME signed bytes on the same
 *     endpoint, then wait for the receipt.
 *  3. Never re-sign after an unclear failure: only a definitive node rejection (nonce / funds / fee / malformed) is
 *     rethrown for the caller to resync + re-sign.
 *  4. Timeout / network error / unreadable response ⇒ possibly accepted: onPending({ txHash }) and poll the receipt
 *     for the precomputed hash (fast node first when RHT_RECEIPT_RPC_URL is set; public RPC last).
 *  5. The sync receipt IS the confirmation the UI books from (RelayConfirmed.receipt).
 * Sequencer unset ⇒ exactly today's call on the public RPC ([raw]).
 */
import type { Hex } from "viem";
import type { RelayReceipt, RelayVia } from "../aa/relayTypes";

export type RpcFn = (method: string, params: unknown[]) => Promise<unknown>;
export type RpcErr = Error & { code?: number; data?: unknown; txHash?: Hex };
export type PendingReason = "sync-timeout" | "sync-error" | "sync-unsupported";

/** -32602 (params rejected at parse) / -32601 (method missing): nothing was accepted ⇒ a plain send is safe. */
export const isNotAccepted = (e: RpcErr) => e.code === -32602 || e.code === -32601;
const TIMEOUT = /timed? ?out|timeout|deadline/i;
/** No (readable) answer, or the node gave up waiting: the tx may be in. */
export const isUnclear = (e: RpcErr) => e.code === undefined || e.code === -32099 || e.code === -32098 || e.code === 4
  || TIMEOUT.test(e.message) || /network|socket|ECONN|fetch failed|aborted|\b50[234]\b/i.test(e.message);
export const isAlreadyKnown = (e: RpcErr) => /already known|known transaction|already imported/i.test(e.message);
export const isNonceErr = (e: RpcErr) => e.code === 6 || /nonce too low|nonce too high|invalid nonce|nonce gap/i.test(e.message);

export type SyncSendResult = { rc: RelayReceipt; via: RelayVia; sendMs: number; minedMs: number; pending: boolean };
export type SyncSendOpts = {
  /** send endpoint: RHT_SEQUENCER_URL when set, else the public RPC */
  send: { name: "sequencer" | "rpc"; rpc: RpcFn };
  /** receipt reader for the slow-path wait (fast node first, public RPC last) */
  getReceipt: (h: Hex) => Promise<RelayReceipt | null>;
  onPending?: (p: { txHash: Hex; reason: PendingReason }) => void;
  pollMs?: number; maxWaitMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
};

export async function syncSend(raw: Hex, txHash: Hex, o: SyncSendOpts): Promise<SyncSendResult> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  const tag = (e: unknown) => Object.assign(e as RpcErr, { txHash });
  let reason: PendingReason;
  try {
    const rc = (await o.send.rpc("eth_sendRawTransactionSync", [raw])) as RelayReceipt;
    return { rc, via: o.send.name === "sequencer" ? "sequencer-sync" : "rpc-sync", sendMs: now() - t0, minedMs: 0, pending: false };
  } catch (e) {
    const err = e as RpcErr;
    if (isNotAccepted(err)) {
      try { await o.send.rpc("eth_sendRawTransaction", [raw]); reason = "sync-unsupported"; }   // SAME signed bytes
      catch (e2) {
        const er2 = e2 as RpcErr;
        if (isAlreadyKnown(er2)) reason = "sync-unsupported";
        else if (isUnclear(er2)) reason = "sync-error";
        else throw tag(er2);   // definitive rejection of the plain send
      }
    } else if (isAlreadyKnown(err)) reason = "sync-timeout";
    else if (isUnclear(err)) reason = err.code === 4 || TIMEOUT.test(err.message) ? "sync-timeout" : "sync-error";
    else throw tag(err);       // definitive node rejection: the caller may resync its nonce and re-sign
  }
  const t1 = now();
  o.onPending?.({ txHash, reason });
  const deadline = t1 + (o.maxWaitMs ?? 20_000);
  for (;;) {
    const rc = await o.getReceipt(txHash).catch(() => null);
    if (rc) return { rc, via: "rpc-wait", sendMs: t1 - t0, minedMs: now() - t1, pending: true };
    if (now() > deadline) throw tag(Object.assign(new Error(`relayer tx ${txHash} not confirmed (timeout)`), { code: -32000, unclear: true }));
    await sleep(o.pollMs ?? 50);
  }
}

/** JSON-RPC over fetch with keep-alive (Node's fetch pools the TLS connection); errors as RpcErr { code, message, data }. */
export function jsonRpc(url: string, abortMs = 25_000): RpcFn {
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

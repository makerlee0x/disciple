/**
 * Client side of the relay wire contract (lib/aa/relayTypes). One POST, no polling: asks for the NDJSON stream
 * (RELAY_STREAM_ACCEPT); the server answers with one RelayConfirmed (full receipt + logs from the sync send) or, on
 * the slow path, RelayPending { txHash } then the pushed RelayConfirmed / RelayFailed. A server without streaming
 * (old deploy) answers plain JSON-RPC, which is passed through unchanged.
 */
import type { Hex } from "viem";
import { RELAY_METHOD, RELAY_STREAM_ACCEPT, UNCLEAR_RELAY, type RelayConfirmed, type RelayErrorData, type RelayFrame, type RelayPending, type RelayUnclearInfo, type RelayUnclearReason } from "./relayTypes";

export type RelayAnswer = { result?: RelayConfirmed; error?: { code: number; message: string; data?: unknown } };

/** `meta.pressId` (rapid taps): the same id on every retry of ONE press ⇒ the relay doesn't count those retries toward
 * the per-sender send limit (lib/server/limits.hitSenderSend). Sent as an optional 3rd param; absent ⇒ wire unchanged. */
export async function relaySend(url: string, wire: unknown, entryPoint: Hex, onPending?: (p: RelayPending) => void, fetchImpl: typeof fetch = fetch, meta?: { pressId?: string }): Promise<RelayAnswer> {
  let r: Response;
  try {
    r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: `${RELAY_STREAM_ACCEPT}, application/json` }, keepalive: true,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: RELAY_METHOD, params: meta?.pressId ? [wire, entryPoint, { pressId: meta.pressId }] : [wire, entryPoint] }) });
  } catch (e) { return { error: { code: -32099, message: `network: ${(e as Error).message}`, data: { unclear: true, reason: "network" } satisfies RelayErrorData } }; }
  if (!(r.headers.get("content-type") || "").includes(RELAY_STREAM_ACCEPT) || !r.body)
    return (await r.json().catch(() => ({ error: { code: -32098, message: `relay response unreadable (HTTP ${r.status})`, data: { unclear: true, reason: "network" } satisfies RelayErrorData } }))) as RelayAnswer;
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "", pending: RelayPending | undefined;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch (e) { return lost(pending, (e as Error).message); }
    if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let f: RelayFrame;
      try { f = JSON.parse(line) as RelayFrame; } catch { continue; }
      if (f.kind === "pending") { pending = f; onPending?.(f); continue; }
      if (f.kind === "confirmed") { void reader.cancel().catch(() => undefined); return { result: f }; }
      void reader.cancel().catch(() => undefined);
      // unclear (receipt timeout) ⇒ the whole RelayErrorData (txHash / userOpHash / relayNonce / reason); else revert as before
      return { error: { code: f.code, message: f.message, data: f.data?.unclear ? f.data : f.data?.revert ?? (f.data?.txHash ? f.data : undefined) } };
    }
    if (chunk.done) return lost(pending, "stream ended without a result");
  }
}
/**
 * Is this relay error an UNCLEAR outcome (the op may still land)? Flagged by the server/client (data.unclear), or an
 * old-server message that says so (timeout / not confirmed / network / 5xx) and isn't a pre-flight rejection.
 * Returns the fields SITE needs (userOpHash, txHash, relayNonce = the relayer EOA nonce, reason); null ⇒ a definite answer.
 */
export function relayUnclear(err: { code?: number; message: string; data?: unknown }, userOpHash?: Hex): RelayUnclearInfo | null {
  const d = err.data && typeof err.data === "object" ? (err.data as RelayErrorData) : undefined;
  if (d?.notSent === true && d.unclear !== true) return null;   // AUDIT L2: the server KNOWS nothing was sent ⇒ definite
  if (d?.unclear !== true && !(UNCLEAR_RELAY.test(err.message) && !/simulation|revert|AA[0-9]{2}/i.test(err.message))) return null;
  const reason: RelayUnclearReason = d?.reason ?? (/stream lost/i.test(err.message) ? "stream-lost" : /not confirmed|timeout|timed out/i.test(err.message) && d?.txHash ? "receipt-timeout" : "network");
  const uoh = d?.userOpHash ?? userOpHash;
  return { unclear: true, reason, ...(uoh ? { userOpHash: uoh } : {}), ...(d?.txHash ? { txHash: d.txHash } : {}), ...(typeof d?.relayNonce === "number" ? { relayNonce: d.relayNonce } : {}) };
}

/** Stream cut before a terminal frame: unclear (the tx may land); keep txHash / userOpHash / relayNonce if the server had sent them. */
function lost(p: RelayPending | undefined, why: string): RelayAnswer {
  const data: RelayErrorData = { unclear: true, reason: "stream-lost", ...(p ? { txHash: p.txHash, userOpHash: p.userOpHash, ...(p.relayNonce !== undefined ? { relayNonce: p.relayNonce } : {}) } : {}) };
  return { error: { code: -32099, message: `network: relay stream lost (${why})`, data } };
}

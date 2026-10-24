/**
 * Client side of the relay wire contract (lib/aa/relayTypes). One POST, no polling: asks for the NDJSON stream
 * (RELAY_STREAM_ACCEPT); the server answers with one RelayConfirmed (full receipt + logs from the sync send) or, on
 * the slow path, RelayPending { txHash } then the pushed RelayConfirmed / RelayFailed. A server without streaming
 * (old deploy) answers plain JSON-RPC, which is passed through unchanged.
 */
import type { Hex } from "viem";
import { RELAY_METHOD, RELAY_STREAM_ACCEPT, type RelayConfirmed, type RelayFrame, type RelayPending } from "./relayTypes";

export type RelayAnswer = { result?: RelayConfirmed; error?: { code: number; message: string; data?: unknown } };

export async function relaySend(url: string, wire: unknown, entryPoint: Hex, onPending?: (p: RelayPending) => void, fetchImpl: typeof fetch = fetch): Promise<RelayAnswer> {
  let r: Response;
  try {
    r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: `${RELAY_STREAM_ACCEPT}, application/json` }, keepalive: true,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: RELAY_METHOD, params: [wire, entryPoint] }) });
  } catch (e) { return { error: { code: -32099, message: `network: ${(e as Error).message}` } }; }
  if (!(r.headers.get("content-type") || "").includes(RELAY_STREAM_ACCEPT) || !r.body)
    return (await r.json().catch(() => ({ error: { code: -32098, message: `relay response unreadable (HTTP ${r.status})` } }))) as RelayAnswer;
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
      return { error: { code: f.code, message: f.message, data: f.data?.revert ?? (f.data?.txHash ? f.data : undefined) } };
    }
    if (chunk.done) return lost(pending, "stream ended without a result");
  }
}
/** Stream cut before a terminal frame: ambiguous; keep the txHash if the server had sent it. */
function lost(p: RelayPending | undefined, why: string): RelayAnswer {
  return { error: { code: -32099, message: `network: relay stream lost (${why})`, data: p ? { txHash: p.txHash, userOpHash: p.userOpHash } : undefined } };
}

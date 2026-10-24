import "server-only";
/**
 * NDJSON receipt push for disciple_sendUserOperationSync (wire contract: lib/aa/relayTypes). Kept out of
 * app/api/bundler/route.ts so it drops onto #140's route unchanged: pass #140's deferred `finish` (HybridLimiter
 * syncs + flushRelayTrust via lib/server/defer afterResponse) as `settle`; on this base it is the awaited flushTrust.
 *
 * Frames: normally ONE RelayConfirmed (full receipt + logs from eth_sendRawTransactionSync). If the sync send timed
 * out / errored after signing: RelayPending { txHash } first, then RelayConfirmed (or RelayFailed) when the receipt
 * lands — pushed on this same response, the client never polls.
 */
import type { UserOp } from "../aa/core";
import { userOpHash } from "../aa/core";
import { robinhoodTestnet } from "../chains";
import { RELAY_METHOD, RELAY_STREAM_ACCEPT, relayErrorData, type RelayFrame } from "../aa/relayTypes";
import { isRelayerNotConfigured } from "./relayer";

export function streamRelay(params: unknown[], settle: () => Promise<unknown>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const push = (f: RelayFrame) => ctl.enqueue(enc.encode(JSON.stringify(f) + "\n"));
      const op = params[0] as UserOp;
      let hash: `0x${string}` | undefined;
      try { hash = userOpHash(op, robinhoodTestnet.id); } catch { /* malformed op: fastRelay rejects it */ }
      try {
        const { sendUserOperationSync } = await import("./fastRelay");
        const r = await sendUserOperationSync(op, (p) => { if (hash) push({ kind: "pending", pending: true, userOpHash: hash, txHash: p.txHash, reason: p.reason, ...(p.nonce !== undefined ? { nonce: p.nonce } : {}) }); });
        await settle().catch(() => undefined);
        push(r);
      } catch (e) {
        await settle().catch(() => undefined);
        const x = e as { shortMessage?: string; message?: string };
        const nc = isRelayerNotConfigured(e);
        const m = nc ? "relayer not configured" : (x.shortMessage || x.message || String(e)).split("\n")[0].slice(0, 300);
        // terminal frame: txHash / userOpHash / relayer nonce; on a receipt timeout also unclear + reason (never a failure)
        push({ kind: "error", code: nc ? -32003 : -32000, message: `${RELAY_METHOD}: ${m}`, data: relayErrorData(e, hash) });
      }
      ctl.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": `${RELAY_STREAM_ACCEPT}; charset=utf-8`, "cache-control": "no-store", "x-accel-buffering": "no" } });
}

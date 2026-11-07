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
import { isSendLimitError } from "./limits";

export function streamRelay(params: unknown[], settle: () => Promise<unknown>, onError?: (e: unknown) => Promise<unknown>, beforeSend?: () => Promise<void>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const meta = params[2] as { pressId?: unknown } | undefined;
      const pressId = typeof meta?.pressId === "string" && meta.pressId.length <= 128 ? meta.pressId : undefined;
      const push = (f: RelayFrame) => ctl.enqueue(enc.encode(JSON.stringify(pressId ? { ...f, pressId } : f) + "\n"));   // echo on every frame
      const op = params[0] as UserOp;
      let hash: `0x${string}` | undefined;
      try { hash = userOpHash(op, robinhoodTestnet.id); } catch { /* malformed op: fastRelay rejects it */ }
      try {
        const { sendUserOperationSync } = await import("./fastRelay");
        const r = await sendUserOperationSync(op, (p) => { if (hash) push({ kind: "pending", pending: true, userOpHash: hash, txHash: p.txHash, reason: p.reason, ...(p.relayNonce !== undefined ? { relayNonce: p.relayNonce } : {}) }); }, beforeSend);
        await settle().catch(() => undefined);
        push(r);
      } catch (e) {
        await settle().catch(() => undefined);
        await onError?.(e).catch(() => undefined);   // AUDIT L1: route records pre-send rejections (free retry grant)
        const x = e as { shortMessage?: string; message?: string };
        if (isSendLimitError(e)) { push({ kind: "error", code: -32005, message: `${RELAY_METHOD}: ${e.message}` }); ctl.close(); return; }   // validated, per-sender limit hit: nothing sent
        const nc = isRelayerNotConfigured(e);
        const m = nc ? "relayer not configured" : (x.shortMessage || x.message || String(e)).split("\n")[0].slice(0, 300);
        // terminal frame: txHash / userOpHash / relayNonce / notSent (AUDIT L2: true only for a definite rejection); on a
        // receipt timeout also unclear + reason (never a failure, never notSent)
        push({ kind: "error", code: nc ? -32003 : -32000, message: `${RELAY_METHOD}: ${m}`, data: relayErrorData(e, hash) });
      }
      ctl.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": `${RELAY_STREAM_ACCEPT}; charset=utf-8`, "cache-control": "no-store", "x-accel-buffering": "no" } });
}

import { diagnosticText } from "../aa/diagnostics";
import "server-only";
import { waitUntilFn } from "./defer";
import type { RelayMetrics } from "./relayMetrics";
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

export function streamRelay(params: unknown[], settle: () => Promise<unknown>, onError?: (e: unknown) => Promise<unknown>, beforeSend?: () => Promise<void>, metrics?: RelayMetrics): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      let first = true, closed = false, confirmed = false, protectedWork = false;
      let result: import("../aa/relayTypes").RelayConfirmed | undefined;
      const meta = params[2] as { pressId?: unknown } | undefined;
      const pressId = typeof meta?.pressId === "string" && meta.pressId.length <= 128 ? meta.pressId : undefined;
      const push = (f: RelayFrame) => {
        const at = performance.now();
        ctl.enqueue(enc.encode(JSON.stringify(pressId ? { ...f, pressId } : f) + "\n"));
        metrics?.add("responseFlushEnqueue", performance.now() - at);
        if (first) { first = false; metrics?.mark("firstFrameEnqueued"); }
      };
      const close = () => { if (!closed) { closed = true; try { ctl.close(); } catch { /* reader disconnected */ } metrics?.mark("responseClosed"); } };
      const finish = (r: import("../aa/relayTypes").RelayConfirmed) => {
        result = r; confirmed = true;
        try { push(r); metrics?.mark("confirmedFrameEnqueued"); } catch { metrics?.mark("readerDisconnected"); }
        close();
      };
      const work = async () => {
        const op = params[0] as UserOp;
        let hash: `0x${string}` | undefined;
        try { hash = userOpHash(op, robinhoodTestnet.id); } catch { /* malformed: fastRelay rejects */ }
        try {
          const { sendUserOperationSync } = await import("./fastRelay");
          const r = await sendUserOperationSync(op, (p) => { if (hash) push({ kind: "pending", pending: true, userOpHash: hash, txHash: p.txHash, reason: p.reason, ...(p.relayNonce !== undefined ? { relayNonce: p.relayNonce } : {}) }); }, beforeSend, metrics,
            // Register the WHOLE task with waitUntil BEFORE it starts. Without that guarantee retain old awaited release.
            protectedWork ? finish : undefined);
          result = r;
          if (metrics) await metrics.span("reconciliation", () => settle().catch(() => undefined));
          else await settle().catch(() => undefined);
          if (!confirmed) finish(r);
        } catch (e) {
          // A known final receipt never turns into rollback because cleanup or client delivery failed.
          if (confirmed) { console.warn("[disciple] relay post-receipt cleanup failed", { pressId, reason: diagnosticText((e as Error).message) }); return; }
          await settle().catch(() => undefined);
          await onError?.(e).catch(() => undefined);
          const x = e as { shortMessage?: string; message?: string };
          if (isSendLimitError(e)) { push({ kind: "error", code: -32005, message: `${RELAY_METHOD}: ${e.message}` }); return; }
          const nc = isRelayerNotConfigured(e);
          const m = nc ? "relayer not configured" : (x.shortMessage || x.message || String(e)).split("\n")[0].slice(0, 300);
          const publicError = relayErrorData(e, hash);
          console.info("[disciple] relay rejected " + JSON.stringify({ pressId, userOpHash: hash, txHash: publicError?.txHash, notSent: publicError?.notSent, unclear: publicError?.unclear, reason: diagnosticText(m) }));
          push({ kind: "error", code: nc ? -32003 : -32000, message: `${RELAY_METHOD}: ${m}`, data: publicError });
        } finally {
          metrics?.mark("postWorkComplete"); close();
          if (result) {
            const r = result;
            queueMicrotask(() => { try { console.info("[disciple] relay timing " + JSON.stringify({ pressId, userOpHash: r.userOpHash, txHash: r.txHash, ok: r.success, server: r.t,
              request: metrics ? { startedAtUnixMs: metrics.startedAtUnixMs, ...metrics.snapshot(), protectedPostWork: protectedWork } : undefined })); } catch { /* telemetry never changes delivery */ } });
          }
        }
      };
      // Same request-context hook as historical #140 afterResponse; no new package/env.
      const task = Promise.resolve().then(work), waitUntil = waitUntilFn();
      if (waitUntil) { try { waitUntil(task); protectedWork = true; } catch { /* safe original awaited path */ } }
      return task;

    },
  });
  return new Response(body, { status: 200, headers: { "content-type": `${RELAY_STREAM_ACCEPT}; charset=utf-8`, "cache-control": "no-store", "x-accel-buffering": "no" } });
}

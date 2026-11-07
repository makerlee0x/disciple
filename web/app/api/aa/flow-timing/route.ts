import { requireSelfBundlerMode } from "@/lib/server/relayLockdown";
import { cleanFlowTelemetry } from "@/lib/trade/flowTelemetry";
export const runtime = "nodejs";
const MAX_BYTES = 4096;
let windowStart = 0, count = 0;
/** No chain/KV/wallet/quote calls. One bounded, redacted log after client terminal paint. */
export async function POST(req: Request) {
  try { requireSelfBundlerMode(); } catch { return new Response(null, { status: 404 }); }
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403 });
  const now = Date.now(); if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
  if (++count > 120) return new Response(null, { status: 429 });
  if (Number(req.headers.get("content-length")) > MAX_BYTES || !req.body) return new Response(null, { status: 413 });
  const reader = req.body.getReader(); let size = 0, text = ""; const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.value) { size += part.value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); return new Response(null, { status: 413 }); } text += decoder.decode(part.value, { stream: true }); }
      if (part.done) break;
    }
    text += decoder.decode();
    const row = cleanFlowTelemetry(JSON.parse(text));
    if (!row) return new Response(null, { status: 400 });
    console.info("[disciple] client flow timing " + JSON.stringify(row));
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch { return new Response(null, { status: 400 }); }
}

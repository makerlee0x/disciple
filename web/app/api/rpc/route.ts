/**
 * POST /api/rpc — same-origin read-only JSON-RPC proxy for the browser's pre-send trade reads (lib/server/rpcProxy;
 * client: lib/rpc/readTransport). Never forwards a send.
 */
import { ACTIVE_CHAIN } from "@/lib/chains";
import { kv } from "@/lib/server/kv";
import { HybridLimiter, clientIp } from "@/lib/server/limits";
import { afterResponse } from "@/lib/server/defer";
import { handleRpcProxy, proxyUpstreams } from "@/lib/server/rpcProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAMS = proxyUpstreams(ACTIVE_CHAIN.rpcUrls.default.http[0]);
const LIMITER = new HybridLimiter(() => { try { return kv(); } catch { return null; } });

export async function POST(req: Request) {
  let sync: Promise<void> | undefined;
  const r = await handleRpcProxy(
    { body: await req.text(), ip: clientIp(req.headers), origin: req.headers.get("origin"), host: req.headers.get("x-forwarded-host") || req.headers.get("host"), contentLength: req.headers.get("content-length") },
    { upstreams: UPSTREAMS, limit: (k, l, w) => { const h = LIMITER.hit(k, l, w); sync = h.sync; return h; } },
  );
  if (sync) void afterResponse(() => sync!);
  return new Response(r.body, { status: r.status, headers: r.headers });
}

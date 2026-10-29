import { NextRequest } from "next/server";
import { allowHostsFromEnv, safeFetchImage, SafeFetchError } from "@/lib/server/safeFetch";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs"; // required: lib/server/safeFetch pins sockets to the validated IP via an undici Agent

let warnedOpenAllow = false;

/**
 * Image proxy for token icons whose CDN lacks CORS headers (e.g. DexScreener), so the canvas compositor can read
 * pixels without tainting. All SSRF guards live in lib/server/safeFetch (W-2): http/https, per-hop re-validation
 * (≤3 redirects), resolved-IP range checks with the connection pinned to the validated IP (no DNS rebinding), optional IMG_PROXY_ALLOW_HOSTS, image/* only (no SVG), 5 MB streamed cap.
 * Per-IP rate limit (PUBLIC_GET_LIMITS.imgPerIp): the proxy is SSRF-safe but still burns egress/CPU when uncapped.
 */
export async function GET(req: NextRequest) {
  const rl = await hitLimit(kv(), `img:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.imgPerIp.limit, PUBLIC_GET_LIMITS.imgPerIp.windowSec);
  if (!rl.ok) return new Response("rate limited", { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const raw = req.nextUrl.searchParams.get("url") || "";
  const allow = allowHostsFromEnv();
  if (!allow.length && !warnedOpenAllow && (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production")) {
    // optional allowlist empty in prod: still IP-safe (W-2), but any public host is reachable — set IMG_PROXY_ALLOW_HOSTS
    warnedOpenAllow = true;
    console.warn("[img] IMG_PROXY_ALLOW_HOSTS is unset in production; relying on IP denylist only");
  }
  try {
    const { buf, contentType } = await safeFetchImage(raw, { allowHosts: allow });
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": contentType, "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    const status = e instanceof SafeFetchError ? e.status : 502;
    return new Response(e instanceof SafeFetchError ? e.message : "upstream failed", { status });
  }
}

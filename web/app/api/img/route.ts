import { NextRequest } from "next/server";

/**
 * Image proxy for token icons whose CDN lacks CORS headers (e.g. DexScreener),
 * so the canvas compositor can read pixels without tainting.
 * Guards: https only, no private/loopback hosts, image/* only, ≤2 MB, 5 s timeout.
 */
const MAX = 2 * 1024 * 1024;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|\[?f[cd])/i;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url") || "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (u.protocol !== "https:" || PRIVATE.test(u.hostname)) return new Response("forbidden", { status: 403 });
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(5000), headers: { "user-agent": "Mozilla/5.0 DISCIPLE-icon-proxy" } });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.startsWith("image/")) return new Response("not an image", { status: 415 });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX) return new Response("too large", { status: 413 });
    return new Response(buf, { headers: { "content-type": ct, "cache-control": "public, max-age=86400" } });
  } catch {
    return new Response("upstream failed", { status: 502 });
  }
}

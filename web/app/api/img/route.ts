import { NextRequest } from "next/server";
import { allowHostsFromEnv, safeFetchImage, SafeFetchError } from "@/lib/server/safeFetch";

export const runtime = "nodejs"; // required: lib/server/safeFetch pins sockets to the validated IP via an undici Agent

/**
 * Image proxy for token icons whose CDN lacks CORS headers (e.g. DexScreener), so the canvas compositor can read
 * pixels without tainting. All SSRF guards live in lib/server/safeFetch (W-2): http/https, per-hop re-validation
 * (≤3 redirects), resolved-IP range checks with the connection pinned to the validated IP (no DNS rebinding), optional IMG_PROXY_ALLOW_HOSTS, image/* only (no SVG), 5 MB streamed cap.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url") || "";
  try {
    const { buf, contentType } = await safeFetchImage(raw, { allowHosts: allowHostsFromEnv() });
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

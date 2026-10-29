/** GET /api/image/<sha256> → a moderated coin image from the persistent store (lib/server/imageStore). Immutable. */
import { getImage } from "@/lib/server/imageStore";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";
export const runtime = "nodejs";
export async function GET(req: Request, { params }: { params: { id: string } }) {
  // Cheap KV blob serve, but still cap per-IP so a scanner can't hammer Upstash.
  const rl = await hitLimit(kv(), `imgstore:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.imgPerIp.limit, PUBLIC_GET_LIMITS.imgPerIp.windowSec);
  if (!rl.ok) return new Response("rate limited", { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const buf = await getImage(params.id).catch(() => null);
  if (!buf) return new Response("not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
  });
}

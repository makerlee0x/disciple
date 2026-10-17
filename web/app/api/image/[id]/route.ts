/** GET /api/image/<sha256> → a moderated coin image from the persistent store (lib/server/imageStore). Immutable. */
import { getImage } from "@/lib/server/imageStore";
export const runtime = "nodejs";
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const buf = await getImage(params.id).catch(() => null);
  if (!buf) return new Response("not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
  });
}

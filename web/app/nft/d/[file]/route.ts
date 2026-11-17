/**
 * Disciple metadata on our own domain (config REVEALED_BASE): GET /nft/d/<n>.json → the JSON /admin/mint copied into
 * Vercel Blob (lib/server/nft/art). Our Candy Machine writes these uris on-chain, so the storage can move later without
 * touching any NFT. Images inside point straight at Blob.
 */
import { artBase } from "@/lib/server/nft/art";
import { DISCIPLE_SUPPLY } from "@/lib/nft/config";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const m = file.match(/^(\d{1,3})\.json$/);
  const n = m ? Number(m[1]) : -1;
  if (n < 0 || n >= DISCIPLE_SUPPLY) return new Response("Not found", { status: 404 });
  const base = await artBase();
  if (!base) return new Response("Not found", { status: 404 });
  const r = await fetch(`${base}${n}.json`, { next: { revalidate: 300 } });
  if (!r.ok) return new Response("Not found", { status: 404 });
  return new Response(await r.text(), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" },
  });
}

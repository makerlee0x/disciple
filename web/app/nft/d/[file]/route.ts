/**
 * Disciple metadata + art on our own domain (config REVEALED_BASE), for the NFTs our Candy Machine mints:
 *   /nft/d/<n>.json → metadata built from the repo's trait table (lib/server/nft/art)
 *   /nft/d/<n>.webp → redirect to the art /admin/mint copied into Vercel Blob
 * On-chain uris only name this path, so the art can move (Arweave later, maker 2026-11-17) by changing this file alone.
 */
import { NextResponse } from "next/server";
import { artBase, metadataOf, traitMap } from "@/lib/server/nft/art";
import { DISCIPLE_SUPPLY } from "@/lib/nft/config";

export const runtime = "nodejs";
const CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
const none = () => new Response("Not found", { status: 404 });

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const m = file.match(/^(\d{1,3})\.(json|webp)$/);
  const n = m ? Number(m[1]) : -1;
  if (!m || n < 0 || n >= DISCIPLE_SUPPLY) return none();
  const base = await artBase();
  if (!base) return none();   // nothing until the art is in Blob, so no NFT shows a broken image
  if (m[2] === "webp") return NextResponse.redirect(`${base}${n}.webp`, { status: 308, headers: { "cache-control": CACHE } });
  return NextResponse.json(metadataOf(n, await traitMap()), { headers: { "access-control-allow-origin": "*", "cache-control": CACHE } });
}

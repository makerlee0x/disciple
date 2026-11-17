export const runtime = "nodejs";
/**
 * POST { address, id } → { ok, imageId?, reason? }
 * Picks disciple `id` (Solana mint) as this profile's picture: the mint must be in the verified Disciple collection and held
 * by the profile's linked Solana wallet (/api/nft/link). The art is copied into the image store (same webp normalize as
 * uploads) so it renders everywhere a picture does; the player still saves it with the usual signed /api/profile/meta write.
 * No profile signature here: the result is only usable by the profile whose linked wallet holds the NFT (mayUseImage).
 */
import { NextResponse } from "next/server";
import sharp from "sharp";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { normalizeImage } from "@/lib/server/image";
import { putImage } from "@/lib/server/imageStore";
import { discipleById, solanaConfigured } from "@/lib/server/nft/chain";
import { linksOf, setNftPfp } from "@/lib/server/nft/holders";
import { isEvmAddress, isSolAddress } from "@/lib/nft/config";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const bad = (reason: string, status = 400) => NextResponse.json({ ok: false, reason }, { status });
const MAX_ART_BYTES = 20 * 1024 * 1024;

/** Only https art from IPFS gateways / Arweave / Helius' CDN. */
const ART_HOST = /^https:\/\/([a-z0-9-]+\.)*(pinit\.io|ipfs\.io|nftstorage\.link|arweave\.net|helius-rpc\.com|dweb\.link|mypinata\.cloud|cloudflare-ipfs\.com)\//i;

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `nft:pfp:ip:${clientIp(req.headers)}`, 10, 60);
  if (!rl.ok) return bad("Too many requests, try again shortly.", 429);
  if (!solanaConfigured()) return bad("NFT pictures are off right now.", 503);
  let b: { address?: unknown; id?: unknown };
  try { b = await req.json(); } catch { return bad("Bad JSON"); }
  const addr = String(b?.address ?? "").toLowerCase(), id = String(b?.id ?? "");
  if (!isEvmAddress(addr) || !isSolAddress(id)) return bad("Invalid request.");

  const { sol } = await linksOf(addr);
  if (!sol) return bad("Link your Solana wallet first.", 403);
  const a = await discipleById(id);
  if (!a) return bad("That isn't a Disciple.", 404);
  if (a.owner !== sol) return bad("That Disciple isn't in your linked wallet.", 403);
  if (!ART_HOST.test(a.image)) { console.warn("[disciple] nft pfp: art host not allowed", a.image); return bad("Couldn't load that picture.", 502); }

  let raw: Buffer;
  try {
    const r = await fetch(a.image, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (!r.ok) throw new Error(String(r.status));
    const len = Number(r.headers.get("content-length") || 0);
    if (len > MAX_ART_BYTES) throw new Error("too big");
    raw = Buffer.from(await r.arrayBuffer());
    if (raw.byteLength > MAX_ART_BYTES) throw new Error("too big");
  } catch (e) { console.warn("[disciple] nft pfp: art fetch failed", a.image, String(e)); return bad("Couldn't load that picture. Try again.", 502); }

  try {
    // NFT art can be a big PNG: shrink first, then the same normalize as uploads (EXIF strip, ≤ maxDim webp)
    const small = await sharp(raw, { animated: false, limitInputPixels: 64_000_000 }).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
    const img = await normalizeImage(small);
    const imageId = await putImage(img.buf);
    if (!imageId) return bad("Couldn't store that picture.", 500);
    await setNftPfp(addr, { chain: "sol", id, name: a.name, imageId });
    return NextResponse.json({ ok: true, imageId, name: a.name });
  } catch (e) { console.warn("[disciple] nft pfp: normalize failed", String(e)); return bad("Couldn't read that picture.", 502); }
}

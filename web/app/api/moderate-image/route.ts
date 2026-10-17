import { NextRequest, NextResponse } from "next/server";
import { MODERATION } from "@/lib/config";
import { deny, isDenied } from "@/lib/server/denylist";
import { ImageRejected, normalizeImage } from "@/lib/server/image";
import { pickProvider } from "@/lib/server/moderation";
import { allowUri, putImage } from "@/lib/server/imageStore";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA_URI = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

/**
 * POST multipart/form-data { file } or { uri } → { verdict: allow|block|review, sha256, phash, imageUri? }.
 *  - file: an upload (create page pre-check).
 *  - uri: the EXACT data: URI that will go on-chain as the coin's imageURI (create page, at launch). On allow, the
 *    server records sha256(uri) → stored image in the render allowlist (lib/server/imageStore, W-3e): coin images only
 *    render from that store, so an imageURI set by calling the contract directly shows the placeholder instead.
 * Only "allow" stores the normalized (resized, EXIF-stripped) image, persistently in Upstash (was /tmp on Vercel), and
 * returns imageUri = /api/image/<sha256>. Block → hash added to denylist. Per-IP limit (moderation provider cost).
 */
export async function POST(req: NextRequest) {
  const rl = await hitLimit(kv(), `moderate:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return NextResponse.json({ verdict: "review", error: "Too many checks, try again shortly." }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  let file: File | null = null, uri: string | null = null;
  try {
    const fd = await req.formData();
    file = fd.get("file") as File | null;
    const u = fd.get("uri"); uri = typeof u === "string" && u ? u : null;
  } catch {
    /* fallthrough */
  }
  let input: Buffer;
  if (uri) {
    const m = uri.length <= Math.ceil(MODERATION.maxBytes * 4 / 3) + 64 ? uri.match(DATA_URI) : null;
    if (!m) return NextResponse.json({ verdict: "block", error: "Only PNG, JPG, WEBP or GIF data URIs." }, { status: 415 });
    input = Buffer.from(m[2], "base64");
  } else {
    if (!file || typeof file === "string") return NextResponse.json({ verdict: "block", error: "No file." }, { status: 400 });
    if (file.size > MODERATION.maxBytes) return NextResponse.json({ verdict: "block", error: "File is larger than 2 MB." }, { status: 413 });
    if (file.type && !(MODERATION.mimeTypes as readonly string[]).includes(file.type))
      return NextResponse.json({ verdict: "block", error: "Only PNG, JPG, WEBP or GIF." }, { status: 415 });
    input = Buffer.from(await file.arrayBuffer());
  }

  let img;
  try {
    img = await normalizeImage(input);
  } catch (e) {
    const msg = e instanceof ImageRejected ? e.message : "Not a readable image.";
    return NextResponse.json({ verdict: "block", error: msg }, { status: 415 });
  }

  const hit = await isDenied(img.sha256, img.phash);
  if (hit) return NextResponse.json({ verdict: "block", provider: "denylist", sha256: img.sha256, phash: img.phash });

  const provider = pickProvider();
  let res;
  try {
    res = await provider.check(img.buf, img.mime);
  } catch {
    // Fail closed: provider outage → review, never allow.
    return NextResponse.json({ verdict: "review", provider: provider.name, sha256: img.sha256, phash: img.phash });
  }
  if (res.verdict === "block") await deny(img.sha256, img.phash, `${res.provider}:${JSON.stringify(res.scores || {})}`);

  let imageUri: string | undefined;
  if (res.verdict === "allow") {
    try {
      const id = await putImage(img.buf);
      if (id) {
        imageUri = `/api/image/${id}`;
        if (uri) await allowUri(uri, id);
      }
    } catch { /* storage unavailable: the verdict still returns, the image just won't render until re-checked */ }
  }
  return NextResponse.json({
    verdict: res.verdict, provider: res.provider, scores: res.scores,
    sha256: img.sha256, phash: img.phash, imageUri,
    checkedAt: new Date().toISOString(),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { MODERATION } from "@/lib/config";
import { deny, isDenied } from "@/lib/server/denylist";
import { ImageRejected, normalizeImage } from "@/lib/server/image";
import { pickProvider } from "@/lib/server/moderation";
import { allowUri, putImage } from "@/lib/server/imageStore";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { launchImageUrl } from "@/lib/launchImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The server-side check (nsfwjs on pure-JS tfjs when no hosted provider is set) takes ~3 s warm-up on a cold function,
// more on a small one. The 10-15 s default cut it off on cold starts, so launches and profile photos failed with
// "didn't upload" (maker, 2026-11-16). The provider itself is time-boxed below.
export const maxDuration = 60;
const PROVIDER_TIMEOUT_MS = 25_000;

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms`)), ms))]);

const DATA_URI = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

/**
 * POST multipart/form-data { file } or { uri } → { verdict: allow|block|review, sha256, phash, imageUri? }.
 *  - file: an upload (create page pre-check).
 *  - uri: the EXACT data: URI that will go on-chain as the coin's imageURI (create page, at launch). On allow, the
 *    server records sha256(uri) → stored image in the render allowlist (lib/server/imageStore, W-3e): coin images only
 *    render from that store, so an imageURI set by calling the contract directly shows the placeholder instead.
 * Only "allow" stores the normalized (resized, EXIF-stripped) image, persistently in Upstash (was /tmp on Vercel), and
 * returns imageUri = /api/image/<sha256> and imageUrl = the absolute launch URI (lib/launchImage), which is ALSO added to
 * the render allowlist so a coin launched with it renders. Block → hash added to denylist. Per-IP limit.
 */
export async function POST(req: NextRequest) {
  try {
    return await check(req);
  } catch (e) {
    // never an HTML 500: the create page and Edit profile read JSON and show plain copy
    console.error("[disciple] moderate-image failed", String((e as Error)?.message ?? e).slice(0, 300));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

async function check(req: NextRequest) {
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

  const hit = await isDenied(img.sha256, img.phash).catch((e) => { console.warn("[disciple] moderate-image denylist read failed", String(e?.message ?? e).slice(0, 200)); return false; });
  if (hit) return NextResponse.json({ verdict: "block", provider: "denylist", sha256: img.sha256, phash: img.phash });

  const provider = pickProvider();
  let res;
  try {
    res = await withTimeout(provider.check(img.buf, img.mime), PROVIDER_TIMEOUT_MS);
  } catch (e) {
    console.warn("[disciple] moderate-image provider failed", { provider: provider.name, message: String((e as Error)?.message ?? e).slice(0, 200) });
    // Fail closed: provider outage → review, never allow.
    return NextResponse.json({ verdict: "review", provider: provider.name, sha256: img.sha256, phash: img.phash });
  }
  if (res.verdict === "block") await deny(img.sha256, img.phash, `${res.provider}:${JSON.stringify(res.scores || {})}`).catch(() => {});

  let imageUri: string | undefined, imageUrl: string | undefined;
  if (res.verdict === "allow") {
    try {
      const id = await putImage(img.buf);
      if (id) {
        const abs = launchImageUrl(id);
        await allowUri(abs, id); // the launch writes this URL on-chain (create page); must render
        if (uri) await allowUri(uri, id);
        imageUri = `/api/image/${id}`; imageUrl = abs;
      }
      else console.warn("[disciple] moderate-image not stored: over the size cap", { bytes: img.buf.byteLength });
    } catch (e) {
      // storage unavailable: the verdict still returns, but there is nothing to launch with or show as a photo
      console.error("[disciple] moderate-image store failed", String((e as Error)?.message ?? e).slice(0, 300));
    }
    if (!imageUri) return NextResponse.json({ verdict: res.verdict, error: "not stored", sha256: img.sha256 }, { status: 503 });
  }
  return NextResponse.json({
    verdict: res.verdict, provider: res.provider, scores: res.scores,
    sha256: img.sha256, phash: img.phash, imageUri, imageUrl,
    checkedAt: new Date().toISOString(),
  });
}

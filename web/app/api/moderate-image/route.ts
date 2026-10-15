import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { MODERATION } from "@/lib/config";
import { deny, isDenied } from "@/lib/server/denylist";
import { ImageRejected, normalizeImage } from "@/lib/server/image";
import { pickProvider } from "@/lib/server/moderation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORE = process.env.IMAGE_STORE_DIR || path.join(process.env.VERCEL ? "/tmp" : process.cwd(), ".data", "images"); // Vercel: only /tmp is writable

/**
 * POST multipart/form-data { file } → { verdict: allow|block|review, sha256, phash, imageUri? }.
 * Only "allow" stores the normalized (resized, EXIF-stripped) image and returns an imageUri
 * that may go into coin metadata. Block → hash added to denylist.
 */
export async function POST(req: NextRequest) {
  let file: File | null = null;
  try {
    file = (await req.formData()).get("file") as File | null;
  } catch {
    /* fallthrough */
  }
  if (!file || typeof file === "string") return NextResponse.json({ verdict: "block", error: "No file." }, { status: 400 });
  if (file.size > MODERATION.maxBytes) return NextResponse.json({ verdict: "block", error: "File is larger than 2 MB." }, { status: 413 });
  if (file.type && !(MODERATION.mimeTypes as readonly string[]).includes(file.type))
    return NextResponse.json({ verdict: "block", error: "Only PNG, JPG, WEBP or GIF." }, { status: 415 });

  let img;
  try {
    img = await normalizeImage(Buffer.from(await file.arrayBuffer()));
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
      await fs.mkdir(STORE, { recursive: true });
      await fs.writeFile(path.join(STORE, img.sha256 + ".webp"), img.buf);
    } catch { /* storage is best-effort; the verdict still returns */ }
    imageUri = `disciple-img://${img.sha256}`; // TODO: pin to IPFS/R2 and return the public URI
  }
  return NextResponse.json({
    verdict: res.verdict, provider: res.provider, scores: res.scores,
    sha256: img.sha256, phash: img.phash, imageUri,
    checkedAt: new Date().toISOString(),
  });
}

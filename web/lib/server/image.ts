import "server-only";
import { createHash } from "crypto";
import sharp, { type Metadata } from "sharp";
import { MODERATION } from "@/lib/config";

const FORMATS: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export class ImageRejected extends Error {}

/** Validate by magic bytes (via sharp), resize to ≤ maxDim, strip EXIF/metadata, hash. */
export async function normalizeImage(input: Buffer) {
  if (input.byteLength > MODERATION.maxBytes) throw new ImageRejected("File is larger than 2 MB.");
  let meta: Metadata;
  try {
    meta = await sharp(input, { animated: false }).metadata();
  } catch {
    throw new ImageRejected("Not a readable image.");
  }
  const mime = meta.format ? FORMATS[meta.format] : undefined;
  if (!mime) throw new ImageRejected("Only PNG, JPG, WEBP or GIF.");
  // .rotate() bakes EXIF orientation; sharp drops all metadata (EXIF/GPS/ICC) unless withMetadata() is called.
  const out = await sharp(input, { animated: false })
    .rotate()
    .resize(MODERATION.maxDim, MODERATION.maxDim, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 90 })
    .toBuffer();
  return { buf: out, mime: "image/webp", sourceMime: mime, sha256: sha256(out), sourceSha256: sha256(input), phash: await dHash(out) };
}

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** 64-bit difference hash (perceptual): robust to re-encode/resize. */
export async function dHash(b: Buffer): Promise<string> {
  const px = await sharp(b).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let hex = "";
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x += 4) {
      let nib = 0;
      for (let k = 0; k < 4; k++) nib = (nib << 1) | (px[y * 9 + x + k] > px[y * 9 + x + k + 1] ? 1 : 0);
      hex += nib.toString(16);
    }
  return hex;
}

export function hamming(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    let x = parseInt(a[i] || "0", 16) ^ parseInt(b[i] || "0", 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

/** Raw RGB 224×224 for classifiers. */
export async function rgb224(b: Buffer) {
  return sharp(b).resize(224, 224, { fit: "cover" }).removeAlpha().raw().toBuffer();
}

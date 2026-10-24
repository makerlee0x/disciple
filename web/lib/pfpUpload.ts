/**
 * Profile picture upload helpers (client). Root cause of "a screenshot won't upload" (lee, 2026-10-24): the 2 MB cap in
 * /api/moderate-image applies to the RAW file, before the server shrinks it to a ≤1024 px webp (~20-60 KB). A retina /
 * phone screenshot PNG is usually 2-8 MB, so it was refused even though the stored copy would be tiny. The browser now
 * shrinks the picture to ≤ PFP_MAX_DIM before upload, so any normal photo or screenshot fits; the server still checks
 * everything (size, format by magic bytes, moderation).
 * Every failure maps to one plain player message (PROFILE_COPY); the detail goes to console.warn('[disciple] …').
 */
import { MODERATION } from "./config";
import { PROFILE_COPY as C } from "./copy/profile";

/** Longest side sent to the server (it normalizes to MODERATION.maxDim anyway). */
export const PFP_MAX_DIM = MODERATION.maxDim;
/** Raw files above this aren't decoded in the browser at all (memory). */
export const PFP_RAW_MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = /^image\/(png|jpeg|webp|gif)$/;

export type PfpFailure = "too-big" | "format" | "rejected" | "busy" | "failed";
export const PFP_ERROR: Record<PfpFailure, string> = {
  "too-big": C["edit.pfp.error.big"],
  format: C["edit.pfp.error.format"],
  rejected: C["edit.pfp.error.rejected"],
  busy: C["edit.pfp.error.busy"],
  failed: C["edit.pfp.error.failed"],
};

/** Plain reason for a /api/moderate-image response that didn't yield a stored image. Pure (unit-tested). */
export function pfpFailure(status: number, body: { verdict?: string; imageUri?: string; error?: string } | null): PfpFailure {
  if (status === 413) return "too-big";
  if (status === 415) return "format";
  if (status === 429) return "busy";
  if (body?.verdict === "block" || body?.verdict === "review") return "rejected";
  return "failed";
}

/** Can this file be shrunk / sent at all? null = ok. */
export function pfpPrecheck(f: { size: number; type: string }): PfpFailure | null {
  if (f.type && !ACCEPT.test(f.type)) return "format";
  if (f.size > PFP_RAW_MAX_BYTES) return "too-big";
  return null;
}

/** Target size for a w×h picture whose longest side must be ≤ max (never enlarged). */
export function fitInside(w: number, h: number, max = PFP_MAX_DIM): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob | null>((res) => { try { c.toBlob((b) => res(b), type, q); } catch { res(null); } });

/**
 * Browser only: decode, shrink to ≤ PFP_MAX_DIM and re-encode (webp, else png, else jpeg), so the upload is small.
 * Falls back to the original file if the browser can't decode or encode it (the server then decides).
 */
export async function shrinkForUpload(file: File): Promise<Blob> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return file;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch (e) { console.warn("[disciple] pfp: browser could not decode the picture", e); return file; }
  try {
    const { w, h } = fitInside(bmp.width, bmp.height);
    // Already small: keep the original bytes (no quality loss).
    if (w === bmp.width && h === bmp.height && file.size <= MODERATION.maxBytes / 2) return file;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    const webp = await toBlob(c, "image/webp", 0.9);
    if (webp && webp.type === "image/webp" && webp.size <= MODERATION.maxBytes) return webp;
    const png = await toBlob(c, "image/png");
    if (png && png.size <= MODERATION.maxBytes) return png;
    return (await toBlob(c, "image/jpeg", 0.9)) || file;
  } finally { bmp.close?.(); }
}

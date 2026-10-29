/**
 * The coin image URI a launch writes on-chain (Launchpad LaunchParams.imageURI). It is permanent, so it is ALWAYS the
 * absolute, content-addressed URL of the moderated stored copy: `${IMAGE_ORIGIN}/api/image/<sha256 of the stored webp>`.
 * Never a data: URI (a ~5-30 KB data: URI costs ~900 gas/char in SSTOREs and pushed real-image launches over the
 * 10M launch callGasLimit cap → paymaster 400). Never relative (other apps / explorers read imageURI too).
 *  - /api/image/<sha> serves bytes whose sha256 IS the id (putImage SET NX, never overwritten), cache-control
 *    "public, max-age=31536000, immutable".
 *  - IMAGE_ORIGIN = NEXT_PUBLIC_IMAGE_ORIGIN, else the live prod alias. app/layout's metadataBase (disciple.vip) does
 *    not resolve yet, so it is NOT used for a permanent URI.
 * Isomorphic (create page + /api/moderate-image).
 */
export const DEFAULT_IMAGE_ORIGIN = "https://disciple-pearl.vercel.app";
const SHA_RE = /^[0-9a-f]{64}$/;

export function imageOrigin(env: string | undefined = process.env.NEXT_PUBLIC_IMAGE_ORIGIN): string {
  const v = (env || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(v) ? v : DEFAULT_IMAGE_ORIGIN;
}

/** Absolute https URL of stored image `id`. Throws for anything that is not a 64-hex sha256. */
export function launchImageUrl(id: string, origin: string = imageOrigin()): string {
  if (!SHA_RE.test(id)) throw new Error(`bad image id ${String(id).slice(0, 80)}`);
  return `${origin}/api/image/${id}`;
}

/** True only for `${origin}/api/image/<sha256>` (exact, absolute https). */
export function isLaunchImageUrl(u: string, origin: string = imageOrigin()): boolean {
  return u.startsWith(`${origin}/api/image/`) && SHA_RE.test(u.slice(origin.length + "/api/image/".length)) && u.startsWith("https://");
}

export type ModerateResponse = { verdict?: string; sha256?: string; imageUri?: string; imageUrl?: string } | null;
export type LaunchImageResult = { ok: true; uri: string } | { ok: false; reason: "block" | "review" | "upload"; detail: string };

/**
 * /api/moderate-image response (for the exact crop) → the launch imageURI. Only a stored "allow" yields a URI; a
 * block, a review / outage, or a missing stored copy all stop the launch before any op is built.
 */
export function launchImageFrom(r: ModerateResponse, origin: string = imageOrigin()): LaunchImageResult {
  if (!r) return { ok: false, reason: "upload", detail: "no moderation response" };
  if (r.verdict === "block") return { ok: false, reason: "block", detail: "blocked" };
  if (r.verdict !== "allow") return { ok: false, reason: "review", detail: `verdict ${String(r.verdict)}` };
  const id = /^\/api\/image\/([0-9a-f]{64})$/.exec(r.imageUri || "")?.[1];
  if (!id) return { ok: false, reason: "upload", detail: "allowed but not stored" };
  const uri = launchImageUrl(id, origin);
  if (r.imageUrl && r.imageUrl !== uri) return { ok: false, reason: "upload", detail: `origin mismatch ${r.imageUrl.slice(0, 120)}` };
  return { ok: true, uri };
}

/** Plain player copy (no jargon). LAUNCH_FAILED_MSG: copy pending lee approval. */
export const LAUNCH_FAILED_MSG = "Launch didn't go through. Nothing was spent. Try again.";
export const IMAGE_COPY = {
  block: "This image can't be used. Please pick a different one.",
  review: "Your icon is still being checked. Try again in a moment.",
  upload: "Your icon didn't upload. Nothing was spent. Try again.",
} as const;

import "server-only";
/**
 * Persistent store for moderated coin images (W-3e). Before this, approved images went to /tmp on Vercel (lost on
 * every cold start). Images live in the shared Upstash store (lib/server/kv) as base64 under a size cap:
 *   img:data:<sha256>  → base64 of the stored copy (normalized webp, ≤ IMAGE_STORE_MAX_BYTES)
 *   img:ok:<sha256(uri)> → <sha256>   the exact on-chain imageURI was moderated and allowed (render allowlist)
 * Vercel Blob (BLOB_READ_WRITE_TOKEN) is not used yet: no @vercel/blob dependency; coin crops are ~5-30 KB webp.
 * Without KV env, kv() is the local dev store.
 */
import { createHash } from "crypto";
import { kv } from "./kv";

export const IMAGE_STORE_MAX_BYTES = 512 * 1024;
const dataKey = (id: string) => `img:data:${id}`;
const okKey = (k: string) => `img:ok:${k}`;
const ID = /^[0-9a-f]{64}$/;
export const uriKeyServer = (uri: string) => createHash("sha256").update(uri).digest("hex");

/** Store a moderated image; returns its id (sha256 of the bytes) or null if over the cap. */
export async function putImage(buf: Buffer): Promise<string | null> {
  if (buf.byteLength > IMAGE_STORE_MAX_BYTES) return null;
  const id = createHash("sha256").update(buf).digest("hex");
  await kv().setNX(dataKey(id), buf.toString("base64"));
  return id;
}
export async function getImage(id: string): Promise<Buffer | null> {
  if (!ID.test(id)) return null;
  const b = await kv().get(dataKey(id));
  return b ? Buffer.from(b, "base64") : null;
}
/** Record that this exact imageURI passed moderation and renders as stored image `id`. */
export async function allowUri(uri: string, id: string) { await kv().set(okKey(uriKeyServer(uri)), id); }
/** For each sha256(uri) key: the stored image id if that uri was moderated. */
export async function resolveKeys(keys: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ks = Array.from(new Set(keys.filter((k) => ID.test(k))));
  const ids = await kv().mget(ks.map(okKey));
  ks.forEach((k, i) => { const id = ids[i]; if (id && ID.test(id)) out[k] = id; });
  return out;
}

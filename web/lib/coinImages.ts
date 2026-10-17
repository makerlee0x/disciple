/**
 * Coin images render ONLY from the moderated store (W-3e). A coin's on-chain imageURI can be set by calling the
 * contract directly, skipping /api/moderate-image; so the site never renders imageURI itself. It hashes the exact URI,
 * asks /api/image/resolve which ones passed moderation (the server records sha256(uri) → stored image id when it
 * moderates that exact URI), and renders the stored copy from /api/image/<id>. Unmoderated → "" (PairArt monogram
 * fallback). Isomorphic; the fetch part is browser-only.
 */
import { withBase, IS_STATIC_PREVIEW, BASE_PATH } from "./base-path";

export const STORE_ID_RE = /^[0-9a-f]{64}$/;
export const storeSrc = (id: string) => withBase(`/api/image/${id}`);
/** true for a /api/image/<sha256> URL (what listLaunches hands out; safe to pass through ?icon=). */
const STORE_SRC_RE = new RegExp(`^(?:${BASE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?/api/image/[0-9a-f]{64}$`);
export const isStoreSrc = (s: string | null | undefined) => !!s && STORE_SRC_RE.test(s);

/** sha256(uri) hex: the allowlist key (same on server and client). */
export async function uriKey(uri: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(uri));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

const cache = new Map<string, string>();   // uri → store src ("" = not moderated), per page load
/** uri → store src for every moderated uri ("" otherwise). Never throws; offline/static preview ⇒ all "". */
export async function moderatedSrcs(uris: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo = Array.from(new Set(uris.filter((u) => u && !cache.has(u))));
  if (todo.length && typeof window !== "undefined" && !IS_STATIC_PREVIEW) {
    try {
      const keys = await Promise.all(todo.map(uriKey));
      for (let i = 0; i < keys.length; i += 200) {
        const r = await fetch(withBase("/api/image/resolve"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: keys.slice(i, i + 200) }) });
        const j = r.ok ? ((await r.json()) as { map?: Record<string, string> }) : {};
        keys.slice(i, i + 200).forEach((k, n) => { const id = j.map?.[k]; cache.set(todo[i + n], id && STORE_ID_RE.test(id) ? storeSrc(id) : ""); });
      }
    } catch { /* leave uncached: retried next load */ }
  }
  for (const u of uris) out.set(u, cache.get(u) ?? "");
  return out;
}

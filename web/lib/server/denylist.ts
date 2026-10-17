import "server-only";
import { MODERATION } from "@/lib/config";
import { kv } from "./kv";
import { hamming } from "./image";

/**
 * Image denylist (blocked uploads; exact sha256 or perceptual-hash near match). Stored in the shared Upstash KV
 * (lib/server/kv) so every serverless instance sees every block and it survives deploys:
 *   img:deny:sha:<sha256>  → JSON Entry          (exact lookup, SET NX: first reason wins)
 *   img:deny:phash         → set of "<phash>|<sha256>"  (scanned for Hamming distance ≤ MODERATION.phashMaxDistance)
 * Without KV env (local dev) it falls back to an in-memory store for this process only — never /tmp or the
 * filesystem. A KV error in isDenied throws (the upload fails closed, never skips the check); a KV error in deny is
 * logged and swallowed so the caller still returns its "block" verdict.
 */
export type Entry = { sha256: string; phash: string; reason: string; at: string };
export interface DenyStore {
  get(k: string): Promise<string | null>;
  setNX(k: string, v: string): Promise<boolean>;
  sadd(k: string, ...m: string[]): Promise<void>;
  smembers(k: string): Promise<string[]>;
}
export const SHA_KEY = (sha: string) => `img:deny:sha:${sha}`;
export const PHASH_SET = "img:deny:phash";

export function memoryDenyStore(): DenyStore {
  const kvs = new Map<string, string>(), sets = new Map<string, Set<string>>();
  return {
    async get(k) { return kvs.get(k) ?? null; },
    async setNX(k, v) { if (kvs.has(k)) return false; kvs.set(k, v); return true; },
    async sadd(k, ...m) { const s = sets.get(k) ?? new Set<string>(); m.forEach((x) => s.add(x)); sets.set(k, s); },
    async smembers(k) { return Array.from(sets.get(k) ?? []); },
  };
}

export function createDenylist(store: DenyStore, maxDistance: number = MODERATION.phashMaxDistance) {
  const parse = (v: string | null): Entry | null => { if (!v) return null; try { return JSON.parse(v) as Entry; } catch { return null; } };
  return {
    async isDenied(sha: string, phash: string): Promise<Entry | null> {
      const exact = parse(await store.get(SHA_KEY(sha)));
      if (exact) return exact;
      for (const m of await store.smembers(PHASH_SET)) {
        const i = m.lastIndexOf("|"), p = m.slice(0, i), s = m.slice(i + 1);
        if (p && hamming(p, phash) <= maxDistance) return parse(await store.get(SHA_KEY(s))) ?? { sha256: s, phash: p, reason: "denylist", at: "" };
      }
      return null;
    },
    async deny(sha: string, phash: string, reason: string): Promise<void> {
      const e: Entry = { sha256: sha, phash, reason: reason.slice(0, 500), at: new Date().toISOString() };
      if (!(await store.setNX(SHA_KEY(sha), JSON.stringify(e)))) return; // already denied
      if (phash) await store.sadd(PHASH_SET, `${phash}|${sha}`);
    },
  };
}

const g = globalThis as unknown as { __discipleDenyMem?: DenyStore };
/** Upstash when configured; otherwise a process-local in-memory store (dev only; not shared across instances). */
function store(): DenyStore {
  const k = kv();
  if (k.kind === "upstash") return k;
  if (process.env.VERCEL && !g.__discipleDenyMem) console.warn("[denylist] KV is not configured: the image denylist is in-memory per instance. Set UPSTASH_REDIS_REST_URL/TOKEN.");
  return (g.__discipleDenyMem ??= memoryDenyStore());
}

export const isDenied = (sha: string, phash: string) => createDenylist(store()).isDenied(sha, phash);
export const deny = (sha: string, phash: string, reason: string) =>
  createDenylist(store()).deny(sha, phash, reason).catch((e) => { console.error("[denylist] deny failed:", (e as Error).message); });

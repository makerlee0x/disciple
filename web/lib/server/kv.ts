import "server-only";
/**
 * Small durable KV for site data (usernames, trade index). Same Upstash REST pattern as lib/server/chat/store.ts
 * (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN, plain fetch, no SDK). Without env it falls back to an
 * in-memory store persisted best-effort to KV_LOCAL_FILE (default /tmp/disciple-kv.json): dev only, not shared
 * across Vercel lambdas.
 */
import { promises as fs } from "fs";

export interface Kv {
  kind: "upstash" | "local";
  get(k: string): Promise<string | null>;
  mget(ks: string[]): Promise<(string | null)[]>;
  set(k: string, v: string): Promise<void>;
  /** SET NX (no ttl when ttlSec is 0). true if written. */
  setNX(k: string, v: string, ttlSec?: number): Promise<boolean>;
  del(...k: string[]): Promise<void>;
  /** ZADD NX for each member (dedupe by member). */
  zadd(k: string, items: { score: number; member: string }[]): Promise<void>;
  /** ascending by score */
  /** lowest scores first; rev → highest (newest) first */
  zrange(k: string, limit?: number, rev?: boolean): Promise<string[]>;
  /** ZREM: remove members (exact JSON strings); returns how many were removed. */
  zrem(k: string, ...members: string[]): Promise<number>;
  sadd(k: string, ...m: string[]): Promise<void>;
  smembers(k: string): Promise<string[]>;
  /** Atomic GET + DEL (single-use tokens): the value, or null if absent/expired or already taken. */
  getDel(k: string): Promise<string | null>;
  /** Atomic INCR; the key expires ttlSec after the FIRST increment (fixed-window counter). Returns the new count. */
  incrEx(k: string, ttlSec: number): Promise<number>;
  /** Seconds until k expires (-1 no ttl, -2 missing). */
  ttl(k: string): Promise<number>;
  /** Atomic compare-and-expire: reset k's TTL to ttlSec only while k == v (lease renewal). true if refreshed. */
  expireIfEq(k: string, v: string, ttlSec: number): Promise<boolean>;
  /** Atomic compare-and-delete: DEL k only while k == v (lease release by its owner token). true if deleted. */
  delIfEq(k: string, v: string): Promise<boolean>;
}

/* ---------------- local ---------------- */
type LocalState = { kv: Record<string, { v: string; exp: number }>; z: Record<string, Record<string, number>>; s: Record<string, string[]> };
const g = globalThis as unknown as { __discipleKv?: LocalState; __discipleKvLoaded?: Promise<void> };
const FILE = process.env.KV_LOCAL_FILE || "/tmp/disciple-kv.json";
function local(): Kv {
  const st: LocalState = (g.__discipleKv ??= { kv: {}, z: {}, s: {} });
  const ready = (g.__discipleKvLoaded ??= (async () => {
    try { const j = JSON.parse(await fs.readFile(FILE, "utf8")) as LocalState; Object.assign(st, { kv: j.kv ?? {}, z: j.z ?? {}, s: j.s ?? {} }); } catch { /* first run */ }
  })());
  let t: ReturnType<typeof setTimeout> | null = null;
  const save = () => { if (t) return; t = setTimeout(() => { t = null; fs.writeFile(FILE, JSON.stringify(st)).catch(() => {}); }, 50); };
  const live = (k: string) => { const e = st.kv[k]; if (e && e.exp && e.exp < Date.now()) { delete st.kv[k]; return undefined; } return e; };
  return {
    kind: "local",
    async get(k) { await ready; return live(k)?.v ?? null; },
    async mget(ks) { await ready; return ks.map((k) => live(k)?.v ?? null); },
    async set(k, v) { await ready; st.kv[k] = { v, exp: 0 }; save(); },
    async setNX(k, v, ttl = 0) { await ready; if (live(k)) return false; st.kv[k] = { v, exp: ttl ? Date.now() + ttl * 1000 : 0 }; save(); return true; },
    async del(...ks) { await ready; for (const k of ks) delete st.kv[k]; save(); },
    async zadd(k, items) { await ready; const z = (st.z[k] ??= {}); for (const i of items) if (!(i.member in z)) z[i.member] = i.score; save(); },
    async zrange(k, limit = 1000, rev = false) { await ready; return Object.entries(st.z[k] ?? {}).sort((a, b) => (rev ? b[1] - a[1] : a[1] - b[1])).slice(0, limit).map(([m]) => m); },
    async zrem(k, ...m) { await ready; const z = st.z[k]; if (!z) return 0; let n = 0; for (const x of m) if (x in z) { delete z[x]; n++; } save(); return n; },
    async sadd(k, ...m) { await ready; const s = new Set(st.s[k] ?? []); m.forEach((x) => s.add(x)); st.s[k] = Array.from(s); save(); },
    async smembers(k) { await ready; return st.s[k] ?? []; },
    async getDel(k) { await ready; const e = live(k); if (!e) return null; delete st.kv[k]; save(); return e.v; },
    async incrEx(k, ttl) { await ready; const e = live(k); const n = (e ? Number(e.v) || 0 : 0) + 1; st.kv[k] = { v: String(n), exp: e?.exp || Date.now() + ttl * 1000 }; save(); return n; },
    async ttl(k) { await ready; const e = live(k); return !e ? -2 : e.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -1; },
    async expireIfEq(k, v, ttl) { await ready; const e = live(k); if (!e || e.v !== v) return false; e.exp = Date.now() + ttl * 1000; save(); return true; },
    async delIfEq(k, v) { await ready; const e = live(k); if (!e || e.v !== v) return false; delete st.kv[k]; save(); return true; },
  };
}

/* ---------------- Upstash REST ---------------- */
const EXPIRE_IF_EQ_LUA = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) else return 0 end";
const DEL_IF_EQ_LUA = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const INCR_EX_LUA = "local c=redis.call('INCR',KEYS[1]) if c==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end return c";
function upstash(url: string, token: string): Kv {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const cmd = async <T = unknown>(...args: (string | number)[]): Promise<T> => {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(args), cache: "no-store" });
    const j = (await r.json()) as { result?: T; error?: string };
    if (!r.ok || j.error) throw new Error(`upstash: ${j.error || r.status}`);
    return j.result as T;
  };
  return {
    kind: "upstash",
    get: (k) => cmd<string | null>("GET", k),
    async mget(ks) { return ks.length ? ((await cmd<(string | null)[]>("MGET", ...ks)) ?? []) : []; },
    async set(k, v) { await cmd("SET", k, v); },
    async setNX(k, v, ttl = 0) { return (await cmd<string | null>(...(ttl ? ["SET", k, v, "NX", "EX", ttl] : ["SET", k, v, "NX"]))) === "OK"; },
    async del(...ks) { if (ks.length) await cmd("DEL", ...ks); },
    async zadd(k, items) {
      for (let i = 0; i < items.length; i += 200) {
        const args: (string | number)[] = ["ZADD", k, "NX"];
        for (const it of items.slice(i, i + 200)) args.push(it.score, it.member);
        await cmd(...args);
      }
    },
    async zrange(k, limit = 1000, rev = false) { return (await cmd<string[]>(...(rev ? ["ZRANGE", k, 0, limit - 1, "REV"] : ["ZRANGE", k, 0, limit - 1]))) ?? []; },
    async zrem(k, ...m) { return m.length ? Number(await cmd<number>("ZREM", k, ...m)) : 0; },
    async sadd(k, ...m) { if (m.length) await cmd("SADD", k, ...m); },
    async smembers(k) { return (await cmd<string[]>("SMEMBERS", k)) ?? []; },
    getDel: (k) => cmd<string | null>("GETDEL", k),
    async incrEx(k, ttl) { return Number(await cmd<number>("EVAL", INCR_EX_LUA, 1, k, ttl)); },
    async ttl(k) { return Number(await cmd<number>("TTL", k)); },
    async expireIfEq(k, v, ttl) { return Number(await cmd<number>("EVAL", EXPIRE_IF_EQ_LUA, 1, k, v, ttl)) === 1; },
    async delIfEq(k, v) { return Number(await cmd<number>("EVAL", DEL_IF_EQ_LUA, 1, k, v)) === 1; },
  };
}

let inst: Kv | null = null;
export function kv(): Kv {
  if (inst) return inst;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  inst = url && tok ? upstash(url, tok) : local();
  return inst;
}

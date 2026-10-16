import "server-only";
/**
 * Pluggable chat store. Upstash Redis REST (also Vercel KV / Upstash Marketplace env names) when configured,
 * else in-memory (dev only: NOT shared across Vercel lambdas).
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   or   KV_REST_API_URL + KV_REST_API_TOKEN
 * Keys: chat:m:<coin> list (newest first, trimmed to 200) · chat:rl:<addr> bucket · chat:seen:<tx>:<i> dedupe
 *       chat:cur:<coin> last scanned block · chat:lock:<coin> catch-up lock · chat:active zset coin→last sub ts
 */
import { CHAT_LIMITS, type ChatMsg } from "@/lib/chat/types";
import { take, type Bucket } from "@/lib/chat/ratelimit";

export interface ChatStore {
  kind: "upstash" | "memory";
  append(coin: string, m: ChatMsg): Promise<void>;
  /** newest-first raw window (≤200) */
  recent(coin: string, n: number): Promise<ChatMsg[]>;
  rateTake(addr: string, now: number): Promise<{ ok: boolean; retryAfterMs: number }>;
  setNX(key: string, val: string, ttlSec: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, val: string): Promise<void>;
  del(key: string): Promise<void>;
  touchActive(coin: string, now: number): Promise<void>;
  activeSince(since: number): Promise<string[]>;
}

/* ---------------- memory ---------------- */
type Mem = { lists: Map<string, ChatMsg[]>; kv: Map<string, { v: string; exp: number }>; rl: Map<string, Bucket>; active: Map<string, number> };
const g = globalThis as unknown as { __discipleChat?: Mem };
function memory(): ChatStore {
  const m: Mem = (g.__discipleChat ??= { lists: new Map(), kv: new Map(), rl: new Map(), active: new Map() });
  const live = (k: string) => { const e = m.kv.get(k); if (e && e.exp && e.exp < Date.now()) { m.kv.delete(k); return undefined; } return e; };
  return {
    kind: "memory",
    async append(coin, msg) { const l = m.lists.get(coin) ?? []; l.unshift(msg); l.length = Math.min(l.length, CHAT_LIMITS.keepPerCoin); m.lists.set(coin, l); },
    async recent(coin, n) { return (m.lists.get(coin) ?? []).slice(0, n); },
    async rateTake(addr, now) { const r = take(m.rl.get(addr) ?? null, now); m.rl.set(addr, r.bucket); return r; },
    async setNX(k, v, ttl) { if (live(k)) return false; m.kv.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 }); return true; },
    async get(k) { return live(k)?.v ?? null; },
    async set(k, v) { m.kv.set(k, { v, exp: 0 }); },
    async del(k) { m.kv.delete(k); },
    async touchActive(coin, now) { m.active.set(coin, now); },
    async activeSince(since) { return Array.from(m.active.entries()).filter(([, t]) => t >= since).map(([c]) => c); },
  };
}

/* ---------------- Upstash REST (no SDK; fetch) ---------------- */
// Token bucket in Lua so concurrent lambdas can't double-spend. Returns {ok, retryAfterMs}.
const RL_LUA = `local b=redis.call('HMGET',KEYS[1],'t','a') local burst=tonumber(ARGV[2]) local rf=tonumber(ARGV[3]) local now=tonumber(ARGV[1])
local t=tonumber(b[1]) local a=tonumber(b[2]) if t==nil then t=burst a=now end
t=math.min(burst,t+(now-a)/rf) local ok=0 local wait=0
if t>=1 then t=t-1 ok=1 else wait=math.ceil((1-t)*rf) end
redis.call('HSET',KEYS[1],'t',tostring(t),'a',tostring(now)) redis.call('PEXPIRE',KEYS[1],burst*rf*2) return {ok,wait}`;
function upstash(url: string, token: string): ChatStore {
  const cmd = async <T = unknown>(...args: (string | number)[]): Promise<T> => {
    const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args), cache: "no-store" });
    const j = (await r.json()) as { result?: T; error?: string };
    if (!r.ok || j.error) throw new Error(`upstash: ${j.error || r.status}`);
    return j.result as T;
  };
  const pipe = async (cmds: (string | number)[][]) => {
    const r = await fetch(url.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(cmds), cache: "no-store" });
    if (!r.ok) throw new Error(`upstash pipeline: ${r.status}`);
  };
  return {
    kind: "upstash",
    async append(coin, msg) { await pipe([["LPUSH", `chat:m:${coin}`, JSON.stringify(msg)], ["LTRIM", `chat:m:${coin}`, 0, CHAT_LIMITS.keepPerCoin - 1]]); },
    async recent(coin, n) { const l = await cmd<string[]>("LRANGE", `chat:m:${coin}`, 0, n - 1); return (l ?? []).map((s) => JSON.parse(s) as ChatMsg); },
    async rateTake(addr, now) { const [ok, wait] = await cmd<[number, number]>("EVAL", RL_LUA, 1, `chat:rl:${addr}`, now, CHAT_LIMITS.burst, CHAT_LIMITS.refillMs); return { ok: ok === 1, retryAfterMs: wait }; },
    async setNX(k, v, ttl) { return (await cmd<string | null>("SET", k, v, "NX", "EX", ttl)) === "OK"; },
    async get(k) { return cmd<string | null>("GET", k); },
    async set(k, v) { await cmd("SET", k, v); },
    async del(k) { await cmd("DEL", k); },
    async touchActive(coin, now) { await cmd("ZADD", "chat:active", now, coin); },
    async activeSince(since) { return (await cmd<string[]>("ZRANGEBYSCORE", "chat:active", since, "+inf")) ?? []; },
  };
}

let inst: ChatStore | null = null;
export function chatStore(): ChatStore {
  if (inst) return inst;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  inst = url && tok ? upstash(url, tok) : memory();
  return inst;
}

/** History window: oldest→newest, ≤limit, strictly before `before` id if given. */
export async function historyOf(coin: string, limit: number, before?: string): Promise<ChatMsg[]> {
  const all = await chatStore().recent(coin, CHAT_LIMITS.keepPerCoin);
  const f = before ? all.filter((m) => m.id < before) : all;
  return f.slice(0, Math.max(1, Math.min(limit, CHAT_LIMITS.historyMax))).reverse();
}
/** Messages newer than `after` id, oldest→newest. */
export async function messagesAfter(coin: string, after: string): Promise<ChatMsg[]> {
  const all = await chatStore().recent(coin, 100);
  return all.filter((m) => m.id > after).reverse();
}

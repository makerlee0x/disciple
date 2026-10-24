/**
 * Shared fixed-window rate limits (W-1/W-3). The counter lives in the shared Upstash store (lib/server/kv: INCR + EXPIRE
 * in one EVAL), so limits hold across Vercel lambdas; without KV env, kv() is the local in-memory store. If the store
 * errors at runtime, a per-process memory counter is used for that call (degraded, never unlimited).
 * Pure (no server-only): unit-tested by scripts/test-relay-policy.mts.
 */
export type CounterStore = { incrEx(k: string, ttlSec: number): Promise<number>; ttl(k: string): Promise<number> };
export type LimitResult = { ok: boolean; count: number; limit: number; retryAfterSec: number };

const mem = new Map<string, { n: number; exp: number }>();
export const memoryCounter: CounterStore = {
  async incrEx(k, ttl) {
    const now = Date.now(), e = mem.get(k);
    if (!e || e.exp <= now) { mem.set(k, { n: 1, exp: now + ttl * 1000 }); if (mem.size > 50_000) for (const [mk, v] of Array.from(mem)) if (v.exp <= now) mem.delete(mk); return 1; }
    return ++e.n;
  },
  async ttl(k) { const e = mem.get(k); return e ? Math.max(0, Math.ceil((e.exp - Date.now()) / 1000)) : -2; },
};

export async function hitLimit(store: CounterStore, key: string, limit: number, windowSec: number): Promise<LimitResult> {
  let s = store, count: number;
  try { count = await s.incrEx(`rl:${key}`, windowSec); }
  catch { s = memoryCounter; count = await s.incrEx(`rl:${key}`, windowSec); }
  if (count <= limit) return { ok: true, count, limit, retryAfterSec: 0 };
  const t = await s.ttl(`rl:${key}`).catch(() => windowSec);
  return { ok: false, count, limit, retryAfterSec: t > 0 ? t : windowSec };
}

/** Client IP: Vercel sets x-real-ip / the first x-forwarded-for entry (it overwrites client-supplied values). */
export function clientIp(h: { get(name: string): string | null }): string {
  return (h.get("x-real-ip") || (h.get("x-forwarded-for") || "").split(",")[0] || "").trim().toLowerCase() || "unknown";
}

/** Limits for the self-bundler (/api/bundler). Rapid one-tap shots stay well under these. */
export const BUNDLER_LIMITS = {
  /** default 60/60 s; override with BUNDLER_SEND_PER_SENDER (see bundlerSendPerSender) — raising it is lee's call */
  sendPerSender: { limit: 60, windowSec: 60 },
  /** retries of the SAME press (same sender + pressId) that don't count toward sendPerSender (BUNDLER_PRESS_FREE_RETRIES) */
  pressFreeRetries: 2,
  sendPerIp: { limit: 120, windowSec: 60 },
  /** eth_estimateUserOperationGas + disciple_warm (RPC simulation / balance reads) */
  simPerIp: { limit: 120, windowSec: 60 },
} as const;

const posInt = (v: string | undefined, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : d; };
/** sendPerSender with the env override (BUNDLER_SEND_PER_SENDER, BUNDLER_PRESS_FREE_RETRIES; unset ⇒ the defaults above). */
export function bundlerSendPerSender(env: Record<string, string | undefined> = process.env) {
  const free = Number(env.BUNDLER_PRESS_FREE_RETRIES);
  return {
    limit: posInt(env.BUNDLER_SEND_PER_SENDER, BUNDLER_LIMITS.sendPerSender.limit),
    windowSec: BUNDLER_LIMITS.sendPerSender.windowSec,
    pressFreeRetries: Number.isInteger(free) && free >= 0 && free <= 10 ? free : BUNDLER_LIMITS.pressFreeRetries,
  };
}
export const PRESS_ID = /^[0-9a-f]{16,64}$/;
/**
 * Rapid taps (spec item 10, server side): a press's FIRST send counts toward the per-sender limit; its next
 * `pressFreeRetries` sends with the same pressId (client retries after a transient error, rebuilt with a fresh quote)
 * don't. Beyond that — or without a well-formed pressId — every send counts, so a reused id can't bypass the limit.
 * The per-IP limit always counts (checked separately by the route).
 */
export async function hitSenderSend(store: CounterStore, sender: string, pressId: unknown, lim: { limit: number; windowSec: number; pressFreeRetries: number }): Promise<LimitResult> {
  if (typeof pressId === "string" && PRESS_ID.test(pressId) && lim.pressFreeRetries > 0) {
    let n = 1;
    try { n = await store.incrEx(`rl:bundler:press:${sender}:${pressId}`, lim.windowSec); } catch { /* unknown ⇒ counted */ }
    if (n > 1 && n <= 1 + lim.pressFreeRetries) return { ok: true, count: 0, limit: lim.limit, retryAfterSec: 0 };
  }
  return hitLimit(store, `bundler:send:sender:${sender}`, lim.limit, lim.windowSec);
}

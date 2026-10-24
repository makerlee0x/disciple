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

/**
 * Rate limit with the shared store OFF the critical path (latency plan #4). The decision is synchronous, from this
 * instance's memory: est = max(local hits, last shared count seen + shared increments still in flight). Every hit is
 * still INCR'd in the shared store in the background (returned as `sync` — schedule it with afterResponse), and the
 * answer teaches this instance the global count for the next decision, so a burst spread over many lambdas is caught
 * one store round trip later.
 * Tradeoff vs the old awaited INCR (exact across instances): per warm instance, at most the hits that arrive before
 * its first store answer returns (one Upstash round trip, a few ms) can slip past the global limit; with K instances
 * hot the worst-case overshoot is ~K × (hits per round trip). Each instance alone still enforces the full limit, a
 * key that is over the limit in the store is blocked on every instance after its next hit, and store errors fall
 * back to memory only (degraded, never unlimited). The relay's real money guards (checkOpGas fee floor + gas caps,
 * self-pay prefund, simulation for unverified senders, strikes) don't depend on this limiter.
 */
type HybridEntry = { n: number; g: number; pending: number; exp: number };
export type HybridResult = LimitResult & { sync?: Promise<void> };
export class HybridLimiter {
  private m = new Map<string, HybridEntry>();
  constructor(private store: () => CounterStore | null, private clock: () => number = Date.now, private maxKeys = 50_000) {}
  hit(key: string, limit: number, windowSec: number): HybridResult {
    const now = this.clock(), k = `rl:${key}`;
    let e = this.m.get(k);
    if (!e || e.exp <= now) {
      e = { n: 0, g: 0, pending: 0, exp: now + windowSec * 1000 };
      this.m.set(k, e);
      if (this.m.size > this.maxKeys) for (const [mk, v] of Array.from(this.m)) if (v.exp <= now) this.m.delete(mk);
    }
    e.n++;
    let sync: Promise<void> | undefined;
    const s = this.store();
    if (s) {
      const entry = e;
      entry.pending++;
      sync = s.incrEx(k, windowSec).then((c) => { entry.g = Math.max(entry.g, Number(c) || 0); }, () => undefined).finally(() => { entry.pending--; });
    }
    const count = Math.max(e.n, e.g + e.pending);
    const retryAfterSec = Math.max(1, Math.ceil((e.exp - now) / 1000));
    return count <= limit ? { ok: true, count, limit, retryAfterSec: 0, sync } : { ok: false, count, limit, retryAfterSec, sync };
  }
  /** test hook */
  peek(key: string) { return this.m.get(`rl:${key}`); }
}

/** Client IP: Vercel sets x-real-ip / the first x-forwarded-for entry (it overwrites client-supplied values). */
export function clientIp(h: { get(name: string): string | null }): string {
  return (h.get("x-real-ip") || (h.get("x-forwarded-for") || "").split(",")[0] || "").trim().toLowerCase() || "unknown";
}

/** Limits for the self-bundler (/api/bundler). Rapid one-tap shots stay well under these. */
export const BUNDLER_LIMITS = {
  sendPerSender: { limit: 60, windowSec: 60 },
  sendPerIp: { limit: 120, windowSec: 60 },
  /** eth_estimateUserOperationGas + disciple_warm (RPC simulation / balance reads) */
  simPerIp: { limit: 120, windowSec: 60 },
} as const;

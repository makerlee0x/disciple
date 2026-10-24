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
  sendPerSender: { limit: 60, windowSec: 60 },
  sendPerIp: { limit: 120, windowSec: 60 },
  /** eth_estimateUserOperationGas + disciple_warm (RPC simulation / balance reads) */
  simPerIp: { limit: 120, windowSec: 60 },
} as const;

/**
 * pm_getPaymasterAllowance limits (AUDIT #141 L-3). The endpoint is unauthenticated (an allowance is harmless to hand
 * out: sender-bound, every rule re-checked on-chain), so a per-SENDER bucket keyed on the sender alone let anyone
 * exhaust a victim's 30 / 10 min and push them onto the slower per-op path. The per-sender bucket is therefore keyed on
 * caller IP + sender: a third party only burns its own (ip, sender) bucket, and its total issuance stays bounded by the
 * shared per-IP limit. Same numbers as before for the real user (their client asks ~once per 8 min).
 */
export const ALLOWANCE_LIMITS = { perIpSender: { limit: 30, windowSec: 600 } } as const;
export function paymasterAllowanceLimits(ip: string, sender: string): [key: string, limit: number, windowSec: number][] {
  return [
    [`paymaster:ip:${ip}`, BUNDLER_LIMITS.simPerIp.limit, BUNDLER_LIMITS.simPerIp.windowSec],
    [`paymaster:allow:${ip}:${sender.toLowerCase()}`, ALLOWANCE_LIMITS.perIpSender.limit, ALLOWANCE_LIMITS.perIpSender.windowSec],
  ];
}

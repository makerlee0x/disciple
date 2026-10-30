/**
 * Same-origin read proxy for the browser's pre-send trade reads (/api/rpc; client side: lib/rpc/readTransport).
 * Forwards read-only JSON-RPC (lib/rpc/readMethods) to the RH RPC server-side, so a browser that can't reach the
 * public RPC (CORS — e.g. its edge's 400 with `access-control-allow-origin: *,*` —, a flaky connection) still gets
 * its quote / balance / facts. Never forwards a send. Pure (no server-only): unit-tested by scripts/test-rpc-proxy.mts.
 *
 * Guards: body ≤ RPC_PROXY_LIMITS.maxBodyBytes, batch ≤ maxBatch, per-IP rate limit (HybridLimiter, the shared store
 * off the hot path), cross-origin requests refused (not a public RPC for other sites). Upstream: per-attempt timeout,
 * retry with backoff on network error / timeout / 408 / 429 / 5xx / non-JSON / RPC -32005 (≤ 3 attempts, ≤ ~6 s),
 * alternating to the optional fallback upstream when one is configured.
 */
import { READ_METHODS, readParamsOk } from "@/lib/rpc/readMethods";

export const RPC_PROXY_LIMITS = {
  /** reads per IP per window (a trade is ~3–8 reads; only reads whose direct path failed come here) */
  perIp: { limit: 600, windowSec: 60 },
  maxBodyBytes: 32 * 1024,
  maxBatch: 20,
  attempts: 3,
  attemptTimeoutMs: 3_000,
  totalBudgetMs: 6_000,
  backoffMs: [100, 300],
} as const;

type Json = Record<string, unknown>;
export type ProxyResult = { status: number; body: string; headers: Record<string, string> };
export type ProxyDeps = {
  upstreams: string[];
  fetch?: typeof fetch;
  /** synchronous limiter decision (HybridLimiter.hit) */
  limit?: (key: string, limit: number, windowSec: number) => { ok: boolean; retryAfterSec: number };
  sleep?: (ms: number) => Promise<unknown>;
  clock?: () => number;
  log?: (msg: string, d: Record<string, unknown>) => void;
  limits?: Partial<{ [K in keyof typeof RPC_PROXY_LIMITS]: (typeof RPC_PROXY_LIMITS)[K] }>;
};
export type ProxyReq = { body: string; ip: string; origin?: string | null; host?: string | null; contentLength?: string | null };

const JSON_H = { "content-type": "application/json", "cache-control": "no-store" };
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const out = (status: number, v: unknown, extra: Record<string, string> = {}): ProxyResult => ({ status, body: JSON.stringify(v), headers: { ...JSON_H, ...extra } });

function retryableUpstream(status: number, parsed: unknown): boolean {
  if (status === 408 || status === 429 || status >= 500) return true;
  if (parsed === undefined) return true;   // non-JSON body (edge error page)
  const one = (x: unknown) => { const c = (x as { error?: { code?: unknown } } | null)?.error?.code; return c === -32005; };
  return Array.isArray(parsed) ? parsed.some(one) : one(parsed);
}

export async function handleRpcProxy(r: ProxyReq, d: ProxyDeps): Promise<ProxyResult> {
  const L = { ...RPC_PROXY_LIMITS, ...(d.limits ?? {}) };
  const f = d.fetch ?? fetch, sleep = d.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))), clock = d.clock ?? Date.now;
  const log = d.log ?? ((m, x) => console.warn(m, x));
  if (r.origin) {
    let oh = "";
    try { oh = new URL(r.origin).host; } catch {}
    if (!r.host || oh.toLowerCase() !== r.host.toLowerCase()) return out(403, rpcErr(null, -32600, "cross-origin requests are not allowed"));
  }
  if (Number(r.contentLength) > L.maxBodyBytes || r.body.length > L.maxBodyBytes) return out(413, rpcErr(null, -32600, "request too large"));
  let req: unknown;
  try { req = JSON.parse(r.body); } catch { return out(400, rpcErr(null, -32700, "parse error")); }
  const batch = Array.isArray(req);
  const items = (batch ? req : [req]) as Json[];
  if (!items.length || items.length > L.maxBatch) return out(400, rpcErr(null, -32600, `batch must have 1–${L.maxBatch} requests`));
  const bad = items.find((x) => !x || typeof x !== "object" || typeof x.method !== "string" || !READ_METHODS.has(x.method) || !readParamsOk(x.method, x.params));
  if (bad) {
    // reject the WHOLE request: nothing is forwarded when any entry isn't an allowed read (HTTP 200 + JSON-RPC error,
    // so viem surfaces MethodNotFound and does not retry it)
    const errs = items.map((x) => rpcErr(x?.id, -32601, `method not allowed: ${String(x?.method ?? "").slice(0, 64)}`));
    return out(200, batch ? errs : errs[0]);
  }
  const lim = d.limit?.(`rpc:ip:${r.ip}`, L.perIp.limit, L.perIp.windowSec);
  if (lim && !lim.ok) {
    const errs = items.map((x) => rpcErr(x.id, -32005, "rate limited"));
    return out(429, batch ? errs : errs[0], { "retry-after": String(lim.retryAfterSec) });
  }
  const payload = JSON.stringify(batch ? items.map((x) => ({ jsonrpc: "2.0", id: x.id ?? null, method: x.method, params: x.params ?? [] }))
    : { jsonrpc: "2.0", id: items[0].id ?? null, method: items[0].method, params: items[0].params ?? [] });
  const t0 = clock();
  const fails: { url: string; error: string; ms: number }[] = [];
  for (let i = 0; i < L.attempts; i++) {
    const url = d.upstreams[i % d.upstreams.length];
    const left = L.totalBudgetMs - (clock() - t0);
    if (left <= 0) break;
    const ta = clock();
    try {
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(Math.min(L.attemptTimeoutMs, left)) });
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      if (!retryableUpstream(res.status, parsed) && res.ok) {
        if (fails.length) log("[rpc-proxy] upstream recovered", { method: items[0].method, n: items.length, attempt: i + 1, fails });
        return { status: 200, body: text, headers: { ...JSON_H } };
      }
      fails.push({ url: hostOf(url), error: `HTTP ${res.status}${parsed === undefined ? " non-JSON" : ""}`, ms: clock() - ta });
    } catch (e) {
      fails.push({ url: hostOf(url), error: String((e as Error)?.name === "TimeoutError" ? "timeout" : (e as Error)?.message ?? e).slice(0, 120), ms: clock() - ta });
    }
    if (i < L.attempts - 1) await sleep(L.backoffMs[Math.min(i, L.backoffMs.length - 1)] + Math.floor(Math.random() * 50));
  }
  log("[rpc-proxy] upstream failed", { method: items[0].method, n: items.length, fails });
  const errs = items.map((x) => rpcErr(x.id, -32603, "upstream RPC unavailable"));
  return out(502, batch ? errs : errs[0]);
}
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return "upstream"; } };

/** Upstreams: the chain's RPC, then RHT_RECEIPT_RPC_URL when set (optional read node, already used by fastRelay). */
export function proxyUpstreams(primary: string, env: Record<string, string | undefined> = process.env): string[] {
  const fb = env.RHT_RECEIPT_RPC_URL;
  return /^https?:\/\//.test(fb || "") && fb !== primary ? [primary, fb!] : [primary];
}

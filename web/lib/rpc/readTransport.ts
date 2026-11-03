/**
 * Pre-send trade reads (coin facts, route, quote, balance, fees, gas estimate): the browser reads the public RH RPC
 * DIRECTLY first, and on a transport-level failure (CORS / "Failed to fetch", timeout, any non-2xx HTTP status or
 * non-JSON body, or RPC -32005/-32603) retries the SAME request through our same-origin proxy /api/rpc, which
 * forwards it server-side (no browser CORS, its own retry/backoff upstream). lee Oct 30: "Connection hiccup, nothing
 * was sent" — every failed tap died in a browser → public-RPC read before anything was sent.
 *
 * Why direct-first (not proxy-first): the healthy path stays exactly as fast and free as before (0 extra hops,
 * 0 Vercel invocations); the proxy costs one function invocation + ~one Vercel hop only for reads that already
 * failed. A CORS / connection failure surfaces in milliseconds, so failover is fast; a hung direct read is cut at
 * `directTimeoutMs`. After a direct failure the proxy goes FIRST for `stickyMs` (this browser's path to the public
 * RPC is unhealthy: don't pay the failure again on every read), then direct is tried first again.
 *
 * Deterministic answers (reverts, "unsupported block number" for the read floor, bad params) never fail over.
 * Methods outside READ_METHODS (logs, receipts, …) stay direct-only, as before.
 * Every failure carries `rpcAttempts` (via, url, method, ms, error) for the console / tradeNetworkError.
 */
import { custom, http, type Transport } from "viem";
import { READ_METHODS } from "./readMethods";

export const RPC_PROXY_PATH = "/api/rpc";
export type RpcVia = "direct" | "proxy";
export type RpcAttempt = { via: RpcVia; url: string; method: string; ms: number; error: string; status?: number; code?: number };
type Req = (a: { method: string; params?: unknown }) => Promise<unknown>;
type ErrLike = { name?: string; status?: number; code?: number; cause?: unknown; shortMessage?: string; message?: string; walk?: (f: (y: unknown) => boolean) => unknown } | null | undefined;

const RETRY_CODE = new Set([-32005, -32603]);
const TRANSPORT_TEXT = /HTTP request failed|request took too long|failed to fetch|fetch failed|networkerror|load failed|ERR_\w+|socket hang up|ECONNRESET|Unexpected token|is not valid JSON/i;

/** An error worth retrying on the other path: transport-level, not an answer from the node. */
export function shouldFailover(e: unknown): boolean {
  const x = e as ErrLike;
  if (!x) return false;
  const chain: ErrLike[] = [];
  for (let y: ErrLike = x, i = 0; y && i < 6; y = y.cause as ErrLike, i++) chain.push(y);
  for (const y of chain) {
    if (y?.name === "TimeoutError") return true;
    // any HTTP-level failure: the RH RPC answers JSON-RPC errors (reverts, bad block) with HTTP 200, so a non-2xx /
    // non-JSON / CORS-blocked response is the edge (Cloudflare), not the node — e.g. its 400 with `allow-origin: *,*`
    if (y?.name === "HttpRequestError") return true;
    if (typeof y?.code === "number" && RETRY_CODE.has(y.code)) return true;
  }
  if (chain.some((y) => typeof y?.code === "number")) return false;   // the node answered (revert, bad block, …)
  return TRANSPORT_TEXT.test(`${x.shortMessage ?? ""} ${String(x.message ?? e).split("\n")[0]}`);
}

const short = (e: unknown) => String((e as ErrLike)?.shortMessage ?? (e as ErrLike)?.message ?? e).split("\n")[0].slice(0, 200);
const statusOf = (e: unknown): number | undefined => { for (let y = e as ErrLike, i = 0; y && i < 6; y = y.cause as ErrLike, i++) if (typeof y.status === "number") return y.status; return undefined; };
const codeOf = (e: unknown): number | undefined => { for (let y = e as ErrLike, i = 0; y && i < 6; y = y.cause as ErrLike, i++) if (typeof y.code === "number") return y.code; return undefined; };

/** Shared "direct is unhealthy" window (all clients in this tab). */
export class RouteState {
  private until = 0;
  constructor(private clock: () => number = Date.now) {}
  proxyFirst() { return this.clock() < this.until; }
  directFailed(ms: number) { this.until = this.clock() + ms; }
  directOk() { this.until = 0; }
}
export const ROUTE = new RouteState();

/** Same-origin proxy URL in a browser; null elsewhere (SSR / node scripts) ⇒ direct only. */
export function browserProxyUrl(g: unknown = globalThis): string | null {
  try {
    const o = (g as { location?: { origin?: string } }).location?.origin;
    return o && /^https?:\/\//.test(o) ? o + RPC_PROXY_PATH : null;
  } catch { return null; }
}

export type ReadTransportOpts = {
  directUrl: string;
  proxyUrl?: string | null;
  /** cut a hung direct read (default 2.5 s; healthy reads are ~50–150 ms) */
  directTimeoutMs?: number;
  /** the proxy retries upstream itself; this bounds the whole proxy call (default 8 s) */
  proxyTimeoutMs?: number;
  /** viem retries on the proxy path (default 1, backoff 150 ms) */
  proxyRetryCount?: number;
  /** proxy-first window after a direct failure (default 30 s) */
  stickyMs?: number;
  state?: RouteState;
  /** tests: request fns to use instead of viem http() */
  direct?: Req; proxy?: Req;
  log?: (msg: string, d: Record<string, unknown>) => void;
  clock?: () => number;
};

/** The core request fn (exported for tests). */
export function readRequest(o: Omit<ReadTransportOpts, "direct" | "proxy"> & { direct: Req; proxy: Req | null }): Req {
  const state = o.state ?? ROUTE, stickyMs = o.stickyMs ?? 30_000, clock = o.clock ?? Date.now;
  const log = o.log ?? ((m, d) => { if (typeof console !== "undefined") console.warn(m, d); });
  const proxyUrl = o.proxyUrl ?? "/api/rpc";
  return async (args) => {
    const proxy = o.proxy && READ_METHODS.has(args.method) ? o.proxy : null;
    if (!proxy) return o.direct(args);
    const order: RpcVia[] = state.proxyFirst() ? ["proxy", "direct"] : ["direct", "proxy"];
    const attempts: RpcAttempt[] = [];
    let last: unknown;
    for (let i = 0; i < order.length; i++) {
      const via = order[i], t0 = clock();
      try {
        const r = await (via === "direct" ? o.direct : proxy)(args);
        if (via === "direct") state.directOk();
        if (attempts.length) log("[disciple] rpc read recovered", { method: args.method, via, attempts });
        return r;
      } catch (e) {
        last = e;
        attempts.push({ via, url: via === "direct" ? o.directUrl : proxyUrl, method: args.method, ms: clock() - t0, error: short(e), status: statusOf(e), code: codeOf(e) });
        if (!shouldFailover(e)) break;
        if (via === "direct") state.directFailed(stickyMs);
        if (i === 0) log(`[disciple] rpc read failed via ${via}; trying ${order[1]}`, attempts[attempts.length - 1]);
      }
    }
    if (last && typeof last === "object") { try { (last as { rpcAttempts?: RpcAttempt[] }).rpcAttempts = attempts; } catch {} }
    throw last;
  };
}

/** viem transport: direct public RPC, failing over to (or, while direct is unhealthy, preferring) /api/rpc. */
export function readTransport(o: ReadTransportOpts): Transport {
  return (cfg) => {
    const direct = o.direct ?? (http(o.directUrl, { retryCount: 0, timeout: o.directTimeoutMs ?? 2_500 })({ ...cfg, retryCount: 0 }).request as Req);
    const proxy = o.proxyUrl === null || o.proxyUrl === undefined && !o.proxy ? null
      // batch: reads issued in the same tick (tradeViaUsdg's parallel quote + balance, …) share ONE proxy request =
      // one function invocation; the proxy's maxBatch is 20
      : o.proxy ?? (http(o.proxyUrl!, { retryCount: o.proxyRetryCount ?? 1, retryDelay: 150, timeout: o.proxyTimeoutMs ?? 8_000, batch: { batchSize: 20, wait: 0 } })(cfg).request as Req);
    const request = readRequest({ ...o, direct, proxy });
    return custom({ request: request as never }, { key: "read", name: "Read (direct → /api/rpc)", retryCount: 0 })(cfg);
  };
}

/* ---------- labels: which pre-send read failed ---------- */
export type LabeledError = { readLabel?: string; rpcAttempts?: RpcAttempt[] };
/** Tag a rejection of `p` with the pre-send read it came from (first label wins). Adds no awaits. */
export function labelRead<T>(label: string, p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e && typeof e === "object" && !(e as LabeledError).readLabel) { try { (e as LabeledError).readLabel = label; } catch {} }
    throw e;
  });
}
/** label + url + attempts of a labeled read failure (for logs). */
export function readFailure(e: unknown): { read?: string; url?: string; attempts?: RpcAttempt[] } {
  const x = e as (LabeledError & { url?: string; cause?: unknown }) | null;
  let read: string | undefined, attempts: RpcAttempt[] | undefined, url: string | undefined;
  for (let y = x, i = 0; y && i < 6; y = y.cause as typeof x, i++) { read ??= y.readLabel; attempts ??= y.rpcAttempts; url ??= y.url; }
  return { read, url: attempts?.[attempts.length - 1]?.url ?? url, attempts };
}

/** The app's read transport for `directUrl` (the chain's RPC): proxy failover in a browser, direct-only elsewhere. */
export function appReadTransport(directUrl: string): Transport {
  return (cfg) => readTransport({ directUrl, proxyUrl: browserProxyUrl() })(cfg);
}

/* ---------- tap path: hedged + bounded reads (lee Oct 30: "Get rid of the delay entirely") ----------
 * A tap never waits on the sequential direct → proxy failover above (worst case ≈ 2.5 s + 2 × 8 s). The few reads a tap
 * may still need (a cold cache: first tap on a coin, a balance we never saw) race direct AND proxy in parallel and give
 * up after `budgetMs` (default TAP_READ_BUDGET_MS). First answer wins; a deterministic node answer (revert, bad params)
 * on either path is final. Background warming keeps using appReadTransport (no budget, no doubled proxy load).
 */
export const TAP_READ_BUDGET_MS = 400;
/** Nothing in memory at all (first tap on a coin before the warm loop answered): per request / whole read. Reads that
 *  have a memory fallback keep TAP_READ_BUDGET_MS. */
export const COLD_REQ_BUDGET_MS = 1500;
export const COLD_READ_BUDGET_MS = 2500;
export class ReadBudgetError extends Error {
  constructor(public method: string, public budgetMs: number, public rpcAttempts: RpcAttempt[] = []) { super(`tap read ${method} exceeded ${budgetMs} ms`); this.name = "TimeoutError"; }
}
export type RaceOpts = { directUrl: string; proxyUrl?: string | null; budgetMs?: number; direct?: Req; proxy?: Req; clock?: () => number; state?: RouteState };
/** The race request fn (exported for tests). Proxy only for READ_METHODS; no proxy ⇒ direct under the budget. */
export function raceRequest(o: Omit<RaceOpts, "direct" | "proxy"> & { direct: Req; proxy: Req | null }): Req {
  const budget = o.budgetMs ?? TAP_READ_BUDGET_MS, clock = o.clock ?? Date.now, state = o.state ?? ROUTE;
  return (args) => new Promise((resolve, reject) => {
    const proxy = o.proxy && READ_METHODS.has(args.method) ? o.proxy : null;
    const legs: { via: RpcVia; fn: Req }[] = [{ via: "direct", fn: o.direct }, ...(proxy ? [{ via: "proxy" as const, fn: proxy }] : [])];
    const attempts: RpcAttempt[] = [], t0 = clock();
    let settled = false, failed = 0, lastErr: unknown;
    const finish = (f: () => void) => { if (settled) return; settled = true; clearTimeout(timer); f(); };
    const timer = setTimeout(() => finish(() => reject(new ReadBudgetError(args.method, budget, attempts))), budget);
    for (const { via, fn } of legs) {
      fn(args).then((r) => { if (via === "direct") state.directOk(); finish(() => resolve(r)); }, (e) => {
        attempts.push({ via, url: via === "direct" ? o.directUrl : o.proxyUrl ?? RPC_PROXY_PATH, method: args.method, ms: clock() - t0, error: short(e), status: statusOf(e), code: codeOf(e) });
        if (via === "direct" && shouldFailover(e)) state.directFailed(30_000);
        lastErr = e;
        if (!shouldFailover(e)) { finish(() => reject(e)); return; }   // the node answered: final on any path
        if (++failed === legs.length) finish(() => { try { (e as { rpcAttempts?: RpcAttempt[] }).rpcAttempts = attempts; } catch {} reject(lastErr); });
      });
    }
  });
}
/** viem transport for tap-path reads: direct ∥ proxy, first answer wins, hard budget. */
export function raceTransport(o: RaceOpts): Transport {
  return (cfg) => {
    const budget = o.budgetMs ?? TAP_READ_BUDGET_MS;
    const direct = o.direct ?? (http(o.directUrl, { retryCount: 0, timeout: budget })({ ...cfg, retryCount: 0 }).request as Req);
    const proxy = o.proxyUrl === null || o.proxyUrl === undefined && !o.proxy ? null
      : o.proxy ?? (http(o.proxyUrl!, { retryCount: 0, timeout: budget })({ ...cfg, retryCount: 0 }).request as Req);
    return custom({ request: raceRequest({ ...o, direct, proxy }) as never }, { key: "tapRead", name: "Tap read (direct ∥ /api/rpc)", retryCount: 0 })(cfg);
  };
}
/** The app's tap-path transport for `directUrl`. */
export function appRaceTransport(directUrl: string, budgetMs = TAP_READ_BUDGET_MS): Transport {
  return (cfg) => raceTransport({ directUrl, proxyUrl: browserProxyUrl(), budgetMs })(cfg);
}
/** Bound any promise (e.g. a cached shared read some other caller started): rejects with ReadBudgetError after ms. */
export function withinBudget<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ReadBudgetError(label, ms)), ms); })]).finally(() => clearTimeout(t));
}

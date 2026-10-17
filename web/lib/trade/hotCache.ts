/**
 * Short-lived caches for the trade hot path so a warm tap does ZERO chain reads before signing:
 * coin info (curve, graduated, quote token, launch quote price, curve params), preset quotes (refreshed in the
 * background every ~1 s by TradeBridge), balances (polled + refreshed after trades) and referral state.
 * Every cache is a hint: a miss falls back to the live read, and TTLs keep slippage math on fresh quotes.
 */
type Entry<T> = { v: T; at: number };
export class TtlCache<T> {
  private m = new Map<string, Entry<T>>(); private inflight = new Map<string, Promise<T>>();
  constructor(private ttlMs: number, private clock: () => number = Date.now) {}
  fresh(k: string, maxAge = this.ttlMs): T | undefined { const e = this.m.get(k); return e && this.clock() - e.at <= maxAge ? e.v : undefined; }
  set(k: string, v: T) { this.m.set(k, { v, at: this.clock() }); }
  drop(k: string) { this.m.delete(k); }
  dropWhere(f: (k: string) => boolean) { for (const k of [...this.m.keys()]) if (f(k)) this.m.delete(k); }
  /** Cached if fresh, else one shared in-flight read. */
  async get(k: string, read: () => Promise<T>, maxAge = this.ttlMs): Promise<T> {
    const f = this.fresh(k, maxAge); if (f !== undefined) return f;
    let p = this.inflight.get(k);
    if (!p) { p = read().then((v) => { this.set(k, v); return v; }).finally(() => this.inflight.delete(k)); this.inflight.set(k, p); }
    return p;
  }
}
const k = (...a: unknown[]) => a.map((x) => String(x).toLowerCase()).join("|");
export const key = k;
/** Quotes: 1.5 s (≈15 RH blocks) — minOut = quote − slippage stays well inside the 5 % session cap. */
export const QUOTES = new TtlCache<{ amountOut: bigint }>(1500);
/** Balances: 5 s hint (refreshed after every own trade). */
export const BALANCES = new TtlCache<bigint>(5000);
/** Coin facts that never/rarely change. graduated=false is re-read after 5 s. */
export const COIN = new TtlCache<unknown>(10 * 60_000);

/**
 * Last warmed quote per (token, side). A trade of amountIn ≤ the warmed amount can use a linear down-scale of it as a
 * SAFE lower bound for minOut: on a constant-product / concentrated curve the average price only gets better for a
 * smaller trade, so out(a) ≥ out(A)·a/A for a ≤ A. (Bigger amounts are never scaled — that would overestimate.)
 */
export const LAST_QUOTE = new Map<string, { amountIn: bigint; amountOut: bigint; at: number }>();
export function scaledQuote(last: { amountIn: bigint; amountOut: bigint; at: number } | undefined, amountIn: bigint, maxAge: number, now = Date.now()): bigint | undefined {
  if (!last || now - last.at > maxAge || amountIn <= BigInt(0) || amountIn > last.amountIn || last.amountIn === BigInt(0)) return undefined;
  return (last.amountOut * amountIn) / last.amountIn;
}

/**
 * In-flight amounts per route (e.g. "swap|usdg|strategy", "coin|0x…|buy"). Rapid taps quote the SAME pre-trade state,
 * so the 3rd of 3 rapid buys executed after the other two and missed its minOut (seen on-chain: V4TooMuchRequested on
 * the thin USDG/STRATEGY ref pool, tx 0x51da842c…). With trades in flight we quote the marginal amount instead:
 * out(pending + a) − out(pending) (one extra parallel read, only while something is in flight).
 */
export const INFLIGHT = new Map<string, bigint>();
export function addInflight(k: string, a: bigint) { INFLIGHT.set(k, (INFLIGHT.get(k) ?? BigInt(0)) + a); return () => { const v = (INFLIGHT.get(k) ?? BigInt(0)) - a; if (v > BigInt(0)) INFLIGHT.set(k, v); else INFLIGHT.delete(k); }; }
export async function marginalQuote(k: string, amountIn: bigint, quote: (a: bigint, maxAge?: number) => Promise<bigint>): Promise<bigint> {
  const p = INFLIGHT.get(k) ?? BigInt(0);
  if (p <= BigInt(0)) return quote(amountIn);
  const [all, base] = await Promise.all([quote(p + amountIn, 0), quote(p, 0)]);
  return all > base ? all - base : BigInt(0);
}

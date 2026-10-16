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

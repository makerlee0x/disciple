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
  /** Any age, never reads (zero-wait taps): the value and how old it is. */
  peek(k: string): { v: T; ageMs: number } | undefined { const e = this.m.get(k); return e ? { v: e.v, ageMs: this.clock() - e.at } : undefined; }
  /** A read for `k` already in flight (rewarm / get)? */
  pending(k: string): Promise<T> | undefined { return this.inflight.get(k); }
  fresh(k: string, maxAge = this.ttlMs): T | undefined { const e = this.m.get(k); return e && this.clock() - e.at <= maxAge ? e.v : undefined; }
  set(k: string, v: T) { this.m.set(k, { v, at: this.clock() }); }
  private own = new Map<string, number>();
  /** An own-receipt write (zero-wait balances): reads that STARTED before it can't overwrite it (setRead). */
  setOwn(k: string, v: T) { const t = this.clock(); this.own.set(k, t); this.m.set(k, { v, at: t }); }
  /** A read's result, unless an own write landed after the read started (it may predate our trade). */
  setRead(k: string, v: T, startedAt: number): boolean {
    if ((this.own.get(k) ?? -Infinity) >= startedAt) return false;
    this.set(k, v); return true;
  }
  /** now on this cache's clock (read start stamps for setRead) */
  now() { return this.clock(); }
  drop(k: string) { this.m.delete(k); }
  dropWhere(f: (k: string) => boolean) { for (const k of [...this.m.keys()]) if (f(k)) this.m.delete(k); }
  /**
   * Re-quote instead of wipe (latency plan #5): forget the value now (it no longer passes fresh()) and start ONE
   * shared read; a tap that arrives meanwhile joins it through get() instead of starting its own.
   */
  rewarm(k: string, read: () => Promise<T>): Promise<T> {
    this.m.delete(k);
    const t0 = this.clock();
    const p: Promise<T> = read().then((v) => { if (this.inflight.get(k) === p) this.setRead(k, v, t0); return v; })
      .finally(() => { if (this.inflight.get(k) === p) this.inflight.delete(k); });
    this.inflight.set(k, p);
    return p;
  }
  /** Cached if fresh, else one shared in-flight read. race (tap clients): never just JOIN someone else's in-flight read
   *  (a background warm on the sequential failover transport can sit ~2.5 s on a hung direct RPC) — run our own
   *  bounded read beside it, first success wins. */
  async get(k: string, read: () => Promise<T>, maxAge = this.ttlMs, race = false): Promise<T> {
    const f = this.fresh(k, maxAge); if (f !== undefined) return f;
    let p = this.inflight.get(k);
    if (p && race) { const t0 = this.clock(); return firstOk([p, read().then((v) => { this.setRead(k, v, t0); return v; })]); }
    if (!p) { const t0 = this.clock(); p = read().then((v) => { this.setRead(k, v, t0); return v; }).finally(() => this.inflight.delete(k)); this.inflight.set(k, p); }
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
 * PVE/PVP pre-grad quotes are trader-specific (LoginGate / mode caps, PVE sells net of the profit tax): exact
 * (trader, amount) keys only, same 1.5 s TTL, never down-scaled. Separate cache so nothing else can read them.
 */
export const TRADER_QUOTES = new TtlCache<{ amountOut: bigint }>(1500);

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
/**
 * `floorAtPlain` (a one-tap session is active): never price below the PLAIN live quote. The session policy re-quotes at
 * execution and reverts MinOutTooLow when minOut < live × (1 − maxSlippage); rapid taps land in any order, so a quote
 * priced behind the in-flight shots ran ~5–15 % under live whenever this op landed first (Oct 30 testnet repro: $25 / $50
 * / $100 rapid buys refused). The router's own min-out check + trade()'s one fresh-quote resend cover the other order.
 */
export async function marginalQuote(k: string, amountIn: bigint, quote: (a: bigint, maxAge?: number) => Promise<bigint>, floorAtPlain = false): Promise<bigint> {
  const p = INFLIGHT.get(k) ?? BigInt(0);
  if (p <= BigInt(0)) return quote(amountIn);
  if (floorAtPlain) return quote(amountIn, 0);   // marginal ≤ plain on any curve / pool: max(marginal, plain) = plain
  const [all, base] = await Promise.all([quote(p + amountIn, 0), quote(p, 0)]);
  return all > base ? all - base : BigInt(0);
}

/**
 * Same-side shots in flight: the two orders they can land in bound the live output. Earlier shots first ⇒ the marginal
 * out(p + a) − out(p); this one first ⇒ the plain out(a). Parallel AA nonces mean either order happens, so minOut is
 * chosen inside the window that clears BOTH (lib/trade/queuePricing tradeMinOut). Nothing in flight ⇒ lo = hi = quote.
 */
export async function quoteRange(k: string, amountIn: bigint, quote: (a: bigint, maxAge?: number) => Promise<bigint>): Promise<{ lo: bigint; hi: bigint }> {
  const p = INFLIGHT.get(k) ?? BigInt(0);
  if (p <= BigInt(0)) { const q = await quote(amountIn); return { lo: q, hi: q }; }
  const [plain, all, base] = await Promise.all([quote(amountIn, 0), quote(p + amountIn, 0), quote(p, 0)]);
  const m = all > base ? all - base : BigInt(0);
  return m < plain ? { lo: m, hi: plain } : { lo: plain, hi: m };
}

/**
 * Cross-side taps (lee, Oct 30): a buy tapped while our own SELL of the same coin is still in flight was priced on the
 * pre-sell pool; the sell landed first, the buy then got more than quoted and the session policy (minOut ≥ live ×
 * (1 − max)) refused it — a FAVORABLE move. An opposite-side trade can't be composed from single-trade quotes (the
 * path reverses through fees / hook / curve taxes), so a tap waits (bounded) for every EARLIER opposite-side tap on
 * the same coin to settle — landed and seen by the RPC (holdInflightUntilSeen) — and then quotes the real post-trade
 * state. Same-side bursts stay parallel (quoteRange). Only earlier taps are awaited ⇒ no cycles.
 */
export const OPPOSITE_WAIT_MS = 3500;
/**
 * lee, Oct 30 (job 9): "Get rid of the delay entirely." Taps no longer wait for an earlier opposite-side tap: the tap
 * quote model (lib/trade/quoteModel) prices our own in-flight trades on BOTH sides into the [lo, hi] range instead.
 * ms > 0 restores #210's bounded wait (harness A/B only; no env knob). beginTap still tracks taps.
 */
export const OPPOSITE_WAIT = { ms: 0 };
type Tap = { side: string; settled: Promise<void> };
const TAPS = new Map<string, Tap[]>();
export function beginTap(token: string, side: "buy" | "sell") {
  const tk = k(token), list = TAPS.get(tk) ?? [];
  const prior = list.filter((x) => x.side !== side);
  let settle = () => {};
  const me: Tap = { side, settled: new Promise<void>((r) => { settle = r; }) };
  list.push(me); TAPS.set(tk, list);
  let ended = false;
  return {
    /** earlier opposite-side taps on this coin still open when this one began */
    opposite: prior.length,
    /** resolves once they all settled, or after maxMs (then the tap is priced as before; the min-out resend covers it) */
    async waitOpposite(maxMs = OPPOSITE_WAIT_MS): Promise<{ waitedMs: number; timedOut: boolean }> {
      if (!prior.length) return { waitedMs: 0, timedOut: false };
      const t0 = Date.now(); let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.all(prior.map((x) => x.settled)).then(() => false),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(true), maxMs); }),
      ]);
      if (timer) clearTimeout(timer);
      return { waitedMs: Date.now() - t0, timedOut };
    },
    /** this tap is over (landed + seen, failed, or never sent). Idempotent. */
    end() {
      if (ended) return; ended = true; settle();
      const l = TAPS.get(tk); if (!l) return;
      const i = l.indexOf(me); if (i >= 0) l.splice(i, 1);
      if (!l.length) TAPS.delete(tk);
    },
  };
}
export type CoinTap = ReturnType<typeof beginTap>;

/**
 * After our own trade lands, the quotes on its route describe the pre-trade state. Before: wiped (the next tap paid a
 * live quote, ~0.1–0.4 s). Now: the few quotes taps actually used recently are re-read at once (TtlCache.rewarm, so a
 * tap waits for that read instead of starting another), the rest are dropped, and the down-scaling base (LAST_QUOTE)
 * is dropped and re-set from the fresh read. No value from before the trade is ever served after it.
 */
type Quote = { amountOut: bigint };
type Refresher = { read: () => Promise<Quote>; last?: { lk: string; amountIn: bigint }; cache: TtlCache<Quote>; used: number };
export class Requoter {
  private reg = new Map<string, Refresher>();
  constructor(private caches: TtlCache<Quote>[], private last: Map<string, { amountIn: bigint; amountOut: bigint; at: number }>, private clock: () => number = Date.now, private keepMs = 30_000, private maxKeys = 200) {}
  /** Remember how to re-read quote `k` (called wherever a quote is read for a tap or a warm loop). */
  remember(k: string, read: () => Promise<Quote>, last?: { lk: string; amountIn: bigint }, cache: TtlCache<Quote> = this.caches[0]) {
    this.reg.set(k, { read, last, cache, used: this.clock() });
    if (this.reg.size > this.maxKeys) {
      const old = Array.from(this.reg).sort((a, b) => a[1].used - b[1].used).slice(0, this.reg.size - this.maxKeys);
      for (const [ok] of old) this.reg.delete(ok);
    }
  }
  /** Re-read the ≤ max most recently used quotes matching `match`; drop every other matching quote + `lastKeys`. */
  requote(match: (k: string) => boolean, lastKeys: string[], max = 4): string[] {
    const now = this.clock();
    for (const lk of lastKeys) this.last.delete(lk);
    const hot = Array.from(this.reg).filter(([k, r]) => match(k) && now - r.used <= this.keepMs).sort((a, b) => b[1].used - a[1].used).slice(0, max);
    for (const c of this.caches) c.dropWhere(match);
    for (const [k, r] of hot) {
      r.cache.rewarm(k, () => r.read().then((v) => {
        if (r.last) this.last.set(r.last.lk, { amountIn: r.last.amountIn, amountOut: v.amountOut, at: this.clock() });
        return v;
      })).catch(() => undefined);   // failed re-read ⇒ nothing cached ⇒ the next tap reads live
    }
    return hot.map(([k]) => k);
  }
}
export const REQUOTE = new Requoter([QUOTES, TRADER_QUOTES], LAST_QUOTE);

/** Clients whose transport is the bounded tap race (fastClient / coldClient): shared memo reads race instead of joining. */
export const TAP_CLIENTS = new WeakSet<object>();
export const isTapClient = (pc: unknown) => !!pc && typeof pc === "object" && TAP_CLIENTS.has(pc as object);
/** First fulfilled promise; rejects with the last error only when all reject. */
export function firstOk<T>(ps: Promise<T>[]): Promise<T> {
  return new Promise((res, rej) => { let n = ps.length; for (const p of ps) p.then(res, (e) => { if (--n === 0) rej(e); }); });
}

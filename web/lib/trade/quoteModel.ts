/**
 * Zero-wait tap pricing (lee, Oct 30: "Get rid of the delay entirely"). A tap prices from memory, never from a read:
 *
 *  1. Observations: every quote read for a route (warm loop ~1 s, previews, taps, rebuilds) is recorded with the time
 *     its read STARTED (`at`). Two observations of different amounts on the same side fit the route's depth:
 *       out(a) = A·a / (B + a)      (constant-product shape; B = (o2 − o1) / (o1/a1 − o2/a2), A = o1(B + a1)/a1)
 *     A curve / v4 range / multi-hop route is close to that shape over a tap's size; the centered session window
 *     (queuePricing.tradeMinOut, ≈ −7.8 % / +8.5 % at a 15 % max) absorbs the rest and the single fresh-quote resend
 *     covers a miss.
 *  2. Base: the newest exact-amount observation, else the newest observation of the side scaled along the fitted
 *     shape. No fitted depth ⇒ only an exact-amount base is used (a scaled base needs the shape).
 *  3. Our own trades move the route; they are applied to the base from their OWN numbers (no read, no wait):
 *       same side (in → out):  B += in, A −= out        opposite side (its in = our out asset): A += in, B −= out
 *     landed before the base read started ⇒ already in it; sent after the read started and landed (receipt amounts) ⇒
 *     applied for sure; in flight, or sent before / landed after the read (the node may or may not have had it) ⇒
 *     either way can happen, so the range [lo, hi] spans the subsets of those trades.
 *     This replaces both the blocking marginal reads (hotCache.quoteRange) and #210's opposite-side wait.
 * Pure (no viem, no clock unless passed) ⇒ unit-tested in scripts/test-zero-wait.mts.
 */
export type Side = "buy" | "sell";
type Obs = { a: bigint; out: bigint; at: number };
type Own = { id: number; side: Side; aIn: bigint; out: bigint; landedAt?: number; startedAt: number };
export type TapQuote = {
  lo: bigint; hi: bigint; base: bigint;
  /** "exact" = same-amount observation; "model" = scaled along the fitted depth */
  src: "exact" | "model";
  ageMs: number;
  /** own trades applied: landed (definite) / in flight (range) */
  landed: number; inflight: number;
};
const MAX_OBS = 12;
/** observations older than this are not used to fit the depth (other traders moved it) */
const FIT_MAX_AGE_MS = 60_000;
/** own-trade records are dropped this long after landing (every base is newer by then) */
const OWN_KEEP_MS = 60_000;
const n = (x: bigint) => Number(x);

export class QuoteModel {
  private obs = new Map<string, Obs[]>();
  private depth = new Map<string, { B: number; at: number }>();
  private own = new Map<string, Own[]>();
  private seq = 0;
  constructor(private clock: () => number = Date.now) {}
  private sk(route: string, side: Side) { return `${route}|${side}`; }

  /** Record a quote read: `at` = when the read started (its state is at least that old). */
  observe(route: string, side: Side, a: bigint, out: bigint, at = this.clock()) {
    if (a <= BigInt(0) || out <= BigInt(0)) return;
    const k = this.sk(route, side), l = this.obs.get(k) ?? [];
    l.unshift({ a, out, at }); l.sort((x, y) => y.at - x.at);
    if (l.length > MAX_OBS) l.length = MAX_OBS;
    this.obs.set(k, l);
    this.fit(route, side);
  }
  /** Fit B from the newest pair of different amounts with no own trade landing between their reads. */
  private fit(route: string, side: Side) {
    const l = this.obs.get(this.sk(route, side)) ?? [], now = this.clock();
    const owns = this.own.get(route) ?? [];
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const p = l[i], q = l[j];
      if (p.a === q.a || now - q.at > FIT_MAX_AGE_MS) continue;
      // an own trade that may have landed between the two reads (sent ≤ p's read, not landed before q's) ⇒ not one state
      if (owns.some((o) => o.startedAt <= p.at && (o.landedAt ?? Infinity) > q.at)) continue;
      const B = depthOf(n(p.a), n(p.out), n(q.a), n(q.out));
      if (B !== undefined) { this.depth.set(this.sk(route, side), { B, at: p.at }); return; }
    }
  }
  /** Fitted depth (input units), if any. */
  depthOf(route: string, side: Side) { return this.depth.get(this.sk(route, side))?.B; }

  /** Our trade was sent (estimate `out`): returns its id for land()/end(). */
  begin(route: string, side: Side, aIn: bigint, out: bigint, at = this.clock()): number {
    const id = ++this.seq, l = this.own.get(route) ?? [];
    l.push({ id, side, aIn, out, startedAt: at }); this.own.set(route, l);
    return id;
  }
  /** It landed: the receipt's amounts replace the estimate; it now applies to every base read before `at`. */
  land(route: string, id: number, out: bigint | undefined, at = this.clock()) {
    const o = this.own.get(route)?.find((x) => x.id === id); if (!o) return;
    if (out !== undefined && out > BigInt(0)) o.out = out;
    o.landedAt = at;
  }
  /** It failed / was never sent: forget it. (Landed trades are kept until every base is newer.) */
  end(route: string, id: number) {
    const l = this.own.get(route); if (!l) return;
    const i = l.findIndex((x) => x.id === id && x.landedAt === undefined); if (i >= 0) l.splice(i, 1);
  }
  private gc(route: string) {
    const l = this.own.get(route); if (!l) return;
    const now = this.clock();
    const kept = l.filter((o) => o.landedAt === undefined ? now - o.startedAt < 5 * 60_000 : now - o.landedAt < OWN_KEEP_MS);
    if (kept.length) this.own.set(route, kept); else this.own.delete(route);
  }
  /** In-flight own trades on this route (not landed). */
  inflight(route: string) { return (this.own.get(route) ?? []).filter((o) => o.landedAt === undefined).length; }

  /**
   * Sync tap quote for `a` on (route, side), or undefined when memory can't price it (no observation; or only other
   * amounts and no fitted depth; or own trades to apply and no depth). Never reads.
   */
  quote(route: string, side: Side, a: bigint, o: { exactMaxAgeMs?: number } = {}): TapQuote | undefined {
    this.gc(route);
    const l = this.obs.get(this.sk(route, side)) ?? [];
    if (!l.length || a <= BigInt(0)) return undefined;
    const now = this.clock(), exactMax = o.exactMaxAgeMs ?? 15_000;
    const exact = l.find((x) => x.a === a);
    const B0 = this.depth.get(this.sk(route, side))?.B;
    let base: Obs, src: TapQuote["src"];
    if (exact && (now - exact.at <= exactMax || B0 === undefined)) { base = exact; src = "exact"; }
    else if (B0 !== undefined) { base = l[0]; src = "model"; }
    else return undefined;
    // an own trade vs the base read: landed before it ⇒ in the base already; sent after it and landed ⇒ apply for sure;
    // otherwise (in flight, or sent before the read but landed after it: the node may or may not have had it) ⇒ range
    const owns = (this.own.get(route) ?? []).filter((x) => x.landedAt === undefined || x.landedAt > base.at);
    const definite = owns.filter((x) => x.landedAt !== undefined && x.startedAt > base.at), pending = owns.filter((x) => !definite.includes(x));
    if (owns.length && B0 === undefined) return undefined;   // can't move the base without its shape
    const B = B0 ?? 0;
    // A, B at the base's state (floats in raw units)
    const a0 = n(base.a), o0 = n(base.out);
    const A = (o0 * (B + a0)) / a0;
    const apply = (st: { A: number; B: number }, x: Own) => x.side === side
      ? { A: st.A - n(x.out), B: st.B + n(x.aIn) }
      : { A: st.A + n(x.aIn), B: st.B - n(x.out) };
    let st0 = { A, B };
    for (const x of definite) st0 = apply(st0, x);
    const outAt = (st: { A: number; B: number }) => {
      if (!(st.A > 0) || !(st.B + n(a) > 0)) return 0;
      // B = 0 (exact base, no depth, nothing to apply): out = A (the observation itself)
      return B0 === undefined ? o0 : (st.A * n(a)) / (st.B + n(a));
    };
    // subsets of in-flight trades: none, all, each single, same-side only, opposite only (enough for 2–4 taps)
    const subsets: Own[][] = [[], pending, ...pending.map((x) => [x]), pending.filter((x) => x.side === side), pending.filter((x) => x.side !== side)];
    const outs = subsets.map((s) => outAt(s.reduce(apply, st0)));
    // exactness: scale the float model so the no-trade, base amount reproduces the observation bit-for-bit
    const ref = B0 === undefined ? o0 : (A * a0) / (B + a0);
    const scale = ref > 0 ? o0 / ref : 1;
    const toBig = (x: number) => (x > 0 && Number.isFinite(x) ? BigInt(Math.floor(x * scale)) : BigInt(0));
    const exactBase = src === "exact" && !definite.length;   // the read itself, bit-for-bit (floats lose the low bits)
    const vals = outs.map((x, i) => (exactBase && !subsets[i].length ? base.out : toBig(x)));
    const lo = vals.reduce((m, v) => (v < m ? v : m)), hi = vals.reduce((m, v) => (v > m ? v : m));
    const b = exactBase ? base.out : toBig(outAt(st0));
    return { lo, hi, base: b, src, ageMs: now - base.at, landed: definite.length, inflight: pending.length };
  }
  /** Drop everything for a route (e.g. tests). */
  clear(route?: string) {
    if (route === undefined) { this.obs.clear(); this.depth.clear(); this.own.clear(); return; }
    for (const m of [this.obs, this.depth] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (k.startsWith(route + "|")) m.delete(k);
    this.own.delete(route);
  }
}
/** B for out(a) = A·a/(B + a) through two points; undefined when they don't describe a concave route. */
export function depthOf(a1: number, o1: number, a2: number, o2: number): number | undefined {
  const den = o1 / a1 - o2 / a2;
  if (!(Math.abs(den) > 0)) return undefined;
  const B = (o2 - o1) / den;
  return Number.isFinite(B) && B > 0 ? B : undefined;
}
export const MODEL = new QuoteModel();

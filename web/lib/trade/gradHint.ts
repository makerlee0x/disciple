/**
 * Does a curve buy of `quoteIn` graduate the curve (quote ≥ remaining to graduation)? Answered from curve.quoteBuy's
 * `graduates`, remembered per curve for a short TTL so a warm tap (the 1 s preset-quote loop already called quoteBuy)
 * needs no extra RPC: a non-graduating amount A ⇒ every amount ≤ A is non-graduating; a graduating amount A ⇒ every
 * amount ≥ A graduates. Pure (clock injected); unit-tested by scripts/test-relay-policy.mts.
 */
type Entry = { maxNo?: bigint; minYes?: bigint; at: number };
export class GradHint {
  private m = new Map<string, Entry>();
  constructor(private ttlMs = 1500, private clock: () => number = Date.now) {}
  record(curve: string, quoteIn: bigint, graduates: boolean) {
    const k = curve.toLowerCase(), now = this.clock();
    const e: Entry = this.m.get(k) && now - this.m.get(k)!.at <= this.ttlMs ? { ...this.m.get(k)! } : { at: now };
    if (graduates) e.minYes = e.minYes === undefined || quoteIn < e.minYes ? quoteIn : e.minYes;
    else e.maxNo = e.maxNo === undefined || quoteIn > e.maxNo ? quoteIn : e.maxNo;
    e.at = now; this.m.set(k, e);
  }
  /** true / false when known from a fresh observation, undefined ⇒ ask the chain. */
  known(curve: string, quoteIn: bigint): boolean | undefined {
    const e = this.m.get(curve.toLowerCase());
    if (!e || this.clock() - e.at > this.ttlMs) return undefined;
    if (e.minYes !== undefined && quoteIn >= e.minYes) return true;
    if (e.maxNo !== undefined && quoteIn <= e.maxNo) return false;
    return undefined;
  }
  /** After a trade on this curve the remaining amount changed: forget it. */
  drop(curve: string) { this.m.delete(curve.toLowerCase()); }
}

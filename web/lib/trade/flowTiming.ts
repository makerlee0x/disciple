/** Passive press-keyed telemetry: no network, awaits, or trading decisions.
 * Double-rAF is a post-update paint opportunity proxy, not GPU presentation time.
 * Console serialization is deferred until settlement. Missing measurements are null.
 */
type Side = "buy" | "sell";
type Receipt = { userOpHash: string; txHash: string; t?: Record<string, number> };
type Row = { pressId: string | null; side: Side; tap: number; paint?: number; receipt?: number; fill?: number;
  paintPending?: boolean; fillPending?: boolean; ok?: boolean; reason?: string; server?: Record<string, number>;
  userOpHash?: string; txHash?: string; emitted?: boolean; scheduled?: boolean; fallback?: boolean };
export type FlowSpan = { bind(id: string): void; pendingPaint(): void; finish(ok: boolean, reason?: string): void };
type Deps = { now: () => number; frame: (cb: () => void) => void; later: (cb: () => void, ms: number) => void; log: (row: Record<string, unknown>) => void };
const clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
const guarded = (f: () => void) => { try { f(); } catch { /* never break a trade */ } };
export class FlowTiming {
  private rows = new Map<string, Row>();
  constructor(private d: Deps) {}
  begin(side: Side, tap = this.d.now()): FlowSpan {
    const r: Row = { pressId: null, side, tap };
    return {
      bind: id => guarded(() => { r.pressId = id; this.rows.set(id, r); if (this.rows.size > 128) this.rows.delete(this.rows.keys().next().value!); }),
      pendingPaint: () => guarded(() => this.paint(r, "paint")),
      finish: (ok, reason) => guarded(() => {
        if (r.emitted || r.ok === false) return;
        r.ok = ok; if (reason) r.reason = reason; this.ready(r);
        // A background tab can suspend rAF indefinitely. Do not invent paint timings.
        if (!r.fallback) { r.fallback = true; this.d.later(() => guarded(() => this.emit(r)), 2000); }
      }),
    };
  }
  receipt(id: string | undefined, frame: Receipt) {
    guarded(() => {
      const r = id ? this.rows.get(id) : undefined;
      if (!r || r.emitted || r.receipt !== undefined) return;
      r.receipt = this.d.now(); r.userOpHash = frame.userOpHash; r.txHash = frame.txHash;
      if (frame.t) r.server = { ...frame.t };
    });
  }
  fill(id: string | undefined) { guarded(() => { const r = id ? this.rows.get(id) : undefined; if (r) this.paint(r, "fill"); }); }
  private paint(r: Row, stage: "paint" | "fill") {
    const pending = stage === "paint" ? "paintPending" : "fillPending";
    if (r.emitted || r[stage] !== undefined || r[pending]) return;
    r[pending] = true;
    this.d.frame(() => guarded(() => this.d.frame(() => guarded(() => {
      // A fast rollback can replace the pending DOM before it ever paints. Do not claim that paint.
      if (!(stage === "paint" && r.ok === false)) r[stage] = this.d.now();
      r[pending] = false; this.ready(r);
    }))));
  }
  private ready(r: Row) {
    if (r.ok === undefined || r.emitted || r.scheduled || r.paintPending || (r.ok && (r.fillPending || r.fill === undefined))) return;
    r.scheduled = true; this.d.later(() => guarded(() => this.emit(r)), 0);
  }
  private emit(r: Row) {
    if (r.emitted || r.ok === undefined) return;
    r.emitted = true;
    if (r.pressId && this.rows.get(r.pressId) === r) this.rows.delete(r.pressId);
    const elapsed = (at?: number) => at === undefined ? null : Math.round((at - r.tap) * 100) / 100;
    this.d.log({ pressId: r.pressId, side: r.side, ok: r.ok,
      tapToPaint: elapsed(r.paint), tapToReceipt: elapsed(r.receipt), tapToFill: elapsed(r.fill),
      server: r.server ?? null, userOpHash: r.userOpHash ?? null, txHash: r.txHash ?? null,
      ...(r.reason ? { reason: r.reason } : {}) });
  }
}
const flow = new FlowTiming({ now: clock,
  frame: cb => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb); },
  later: (cb, ms) => { setTimeout(cb, ms); },
  log: row => { if (typeof console !== "undefined") console.error("[disciple] flow timing", JSON.stringify(row)); },
});
let click: number | undefined;
export function flowClick() { guarded(() => { click = clock(); }); }
export function takeFlowClick() { const at = click; click = undefined; return at; }
export const beginFlowTiming = (side: Side, at?: number) => flow.begin(side, at);
export const flowReceipt = (id: string | undefined, receipt: Receipt) => flow.receipt(id, receipt);
export const flowFill = (id: string | undefined) => flow.fill(id);

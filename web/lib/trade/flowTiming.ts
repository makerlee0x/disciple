import { clientSelfBundlerMode } from "../aa/sponsorshipMode";
/** Passive press-keyed telemetry: no trade-path awaits or trading decisions.
 * Double-rAF is a post-update paint opportunity proxy, not GPU presentation time.
 * Console serialization is deferred until settlement. Missing measurements are null.
 */
type Side = "buy" | "sell";
type Receipt = { userOpHash: string; txHash: string; t?: Record<string, number> };
export type FlowMark = "requestStart" | "firstByte" | "pendingFrame" | "confirmedFrame" | "applyOwnStart" | "applyOwnEnd";
export type CacheKind = "quote" | "balance" | "allowance";
type Row = { marks: Partial<Record<FlowMark | "doneRender", number>>; cache: Record<CacheKind, { hit: number; miss: number }>; beaconed?: boolean; donePending?: boolean; pressId: string | null; side: Side; tap: number; paint?: number; receipt?: number; fill?: number;
  paintPending?: boolean; fillPending?: boolean; ok?: boolean; reason?: string; server?: Record<string, number>;
  userOpHash?: string; txHash?: string; emitted?: boolean; scheduled?: boolean; fallback?: boolean; watchdog?: boolean; unresolvedReported?: boolean };
export type FlowSpan = { identify(ids: { userOpHash?: string; txHash?: string }): void; bind(id: string): void; pendingPaint(): void; finish(ok: boolean, reason?: string): void };
type Deps = { now: () => number; frame: (cb: () => void) => void; later: (cb: () => void, ms: number) => void; log: (row: Record<string, unknown>) => void; beacon?: (row: Record<string, unknown>) => void };
const clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
const guarded = (f: () => void) => { try { f(); } catch { /* never break a trade */ } };
export class FlowTiming {
  private rows = new Map<string, Row>();
  constructor(private d: Deps) {}
  begin(side: Side, tap = this.d.now()): FlowSpan {
    const r: Row = { pressId: null, side, tap, marks: {}, cache: { quote: { hit: 0, miss: 0 }, balance: { hit: 0, miss: 0 }, allowance: { hit: 0, miss: 0 } } };
    return {
      identify: ids => guarded(() => { if (ids.userOpHash) r.userOpHash = ids.userOpHash; if (ids.txHash) r.txHash = ids.txHash; }),
      bind: id => guarded(() => {
        r.pressId = id; this.rows.set(id, r); if (this.rows.size > 128) this.rows.delete(this.rows.keys().next().value!);
        // Measurement only: a hung fetch/ambiguous result is NOT failure, fill, or permission to retry.
        if (!r.watchdog) { r.watchdog = true; this.d.later(() => guarded(() => this.unresolved(r)), 15_000); }
      }),
      pendingPaint: () => guarded(() => this.paint(r, "paint")),
      finish: (ok, reason) => guarded(() => {
        if (r.emitted || r.ok === false) return;
        r.ok = ok; if (reason) r.reason = reason; this.ready(r); this.beacon(r);
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
  private unresolved(r: Row) {
    if (r.emitted || r.ok !== undefined || r.unresolvedReported) return;
    r.unresolvedReported = true;
    const elapsed = (at?: number) => at === undefined ? null : Math.round((at - r.tap) * 100) / 100;
    this.d.log({ pressId: r.pressId, side: r.side, ok: null, terminal: false, reason: "unresolved",
      elapsedMs: elapsed(this.d.now()), tapToPaint: elapsed(r.paint), tapToReceipt: elapsed(r.receipt), tapToFill: elapsed(r.fill),
      server: r.server ?? null, userOpHash: r.userOpHash ?? null, txHash: r.txHash ?? null });
  }
  private emit(r: Row) {
    if (r.emitted || r.ok === undefined) return;
    r.emitted = true;
    if (!this.d.beacon && r.pressId && this.rows.get(r.pressId) === r) this.rows.delete(r.pressId);
    const elapsed = (at?: number) => at === undefined ? null : Math.round((at - r.tap) * 100) / 100;
    this.d.log({ pressId: r.pressId, side: r.side, ok: r.ok,
      tapToPaint: elapsed(r.paint), tapToReceipt: elapsed(r.receipt), tapToFill: elapsed(r.fill),
      server: r.server ?? null, userOpHash: r.userOpHash ?? null, txHash: r.txHash ?? null,
      ...this.extra(r), ...(r.reason ? { reason: r.reason } : {}) });
  }
  mark(id: string | undefined, mark: FlowMark) { guarded(() => {
    const r = id ? this.rows.get(id) : undefined; if (r && !r.beaconed) r.marks[mark] ??= this.d.now();
  }); }
  cache(id: string | undefined, kind: CacheKind, hit: boolean) { guarded(() => {
    const r = id ? this.rows.get(id) : undefined; if (r && !r.beaconed) r.cache[kind][hit ? "hit" : "miss"]++;
  }); }
  /** Called ONLY by React's terminal-row commit effect. No timer fallback may claim a rendered done. */
  doneRendered(id: string) { guarded(() => {
    const r = this.rows.get(id); if (!r || r.donePending || r.beaconed) return;
    r.donePending = true;
    this.d.frame(() => guarded(() => this.d.frame(() => guarded(() => {
      r.marks.doneRender = this.d.now(); this.beacon(r);
    }))));
  }); }
  private extra(r: Row) {
    const elapsed = (at?: number) => at === undefined ? null : Math.max(0, Math.round((at - r.tap) * 100) / 100);
    return Object.fromEntries([...Object.entries(r.marks).map(([k, v]) => [`tapTo${k[0].toUpperCase()}${k.slice(1)}`, elapsed(v)]),
      ...(["requestStart", "firstByte", "pendingFrame", "confirmedFrame", "applyOwnStart", "applyOwnEnd", "doneRender"] as const).filter(k => r.marks[k] === undefined).map(k => [`tapTo${k[0].toUpperCase()}${k.slice(1)}`, null]),
      ["cache", r.cache]]);
  }
  private beacon(r: Row) {
    if (!this.d.beacon || r.beaconed || r.ok === undefined || r.marks.doneRender === undefined) return;
    r.beaconed = true;
    const delta = (n?: number) => n === undefined ? null : Math.max(0, Math.round((n - r.tap) * 100) / 100);
    // Schedule only AFTER a committed terminal row had a paint opportunity. No trade awaits this.
    this.d.later(() => guarded(() => this.d.beacon?.({ version: 3, pressId: r.pressId, side: r.side, ok: r.ok,
      tapToPaint: delta(r.paint), ...this.extra(r) })), 0);
  }

}
const flow = new FlowTiming({ now: clock,
  frame: cb => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb); },
  later: (cb, ms) => { setTimeout(cb, ms); },
  log: row => { if (typeof console !== "undefined") console.error("[disciple] flow timing " + JSON.stringify(row)); },
  beacon: sendFlowBeacon,
});
let click: number | undefined, pointer: number | undefined;
export function flowPointer(at = clock()) { guarded(() => { const now = clock(); pointer = Number.isFinite(at) && at >= 0 && at <= now + 1 ? at : now; }); }
export function clearFlowPointer() { pointer = undefined; }
export function flowClick() { guarded(() => { const now = clock(); click = pointer !== undefined && now - pointer >= 0 ? pointer : now; pointer = undefined; }); }
export function takeFlowClick() { const at = click; click = undefined; return at; }
export const beginFlowTiming = (side: Side, at?: number) => flow.begin(side, at);
export const flowReceipt = (id: string | undefined, receipt: Receipt) => flow.receipt(id, receipt);
export const flowFill = (id: string | undefined) => flow.fill(id);

/** Read-only mount probe: distinguishes a missing bridge/console collector from missing trade settlement. */
export function flowTimingReady() {
  guarded(() => { if (typeof console !== "undefined") console.error('[disciple] flow timing ready {"version":2,"bridge":"installed"}'); });
}

export const flowMark = (id: string | undefined, mark: FlowMark) => flow.mark(id, mark);
export const flowCache = (id: string | undefined, kind: CacheKind, hit: boolean) => flow.cache(id, kind, hit);
export const flowDoneRendered = (id: string) => flow.doneRendered(id);

/** Existing client mode helper blocks Production; route independently enforces the server gate. No retry/fetch fallback. */
export function sendFlowBeacon(row: Record<string, unknown>) { guarded(() => {
  if (typeof navigator !== "undefined" && clientSelfBundlerMode() && typeof navigator.sendBeacon === "function")
    navigator.sendBeacon("/api/aa/flow-timing", new Blob([JSON.stringify(row)], { type: "text/plain;charset=UTF-8" }));
}); }

import { clientSelfBundlerMode } from "../aa/sponsorshipMode";
/** Passive press-keyed telemetry: no trade-path awaits or trading decisions.
 * Double-rAF is a post-update paint opportunity proxy, not GPU presentation time.
 * Console serialization is deferred until settlement. Missing measurements are null.
 */
type Side = "buy" | "sell";
type Receipt = { userOpHash: string; txHash: string; t?: Record<string, number>; via?: string };
export type FlowMark = "requestStart" | "firstByte" | "pendingFrame" | "confirmedFrame" | "applyOwnStart" | "applyOwnEnd";
export type CacheKind = "quote" | "balance" | "allowance";
type Row = { marks: Partial<Record<FlowMark | "doneRender", number>>; cache: Record<CacheKind, { hit: number; miss: number }>; beaconed?: boolean; donePending?: boolean; pressId: string | null; side: Side; tap: number; paint?: number; receipt?: number; fill?: number;
  paintPending?: boolean; fillPending?: boolean; ok?: boolean; reason?: string; server?: Record<string, number>;
  userOpHash?: string; txHash?: string; via?: string; emitted?: boolean; scheduled?: boolean; fallback?: boolean; watchdog?: boolean; unresolvedReported?: boolean };
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
      if (frame.via) r.via = frame.via;
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
      server: r.server ?? null, via: r.via ?? null, userOpHash: r.userOpHash ?? null, txHash: r.txHash ?? null,
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
  log: row => { if (typeof console !== "undefined") console.error("[disciple] flow timing " + JSON.stringify(row)); showTimingBox(row); },
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

/** Debug only (Team, trade speed 2026-11-20): open any page once with ?timing=1 and each trade's split (tap → request sent
 *  → relay first byte → confirmed → filled, plus the relay's own server stages) shows in a small box bottom right.
 *  ?timing=0 turns it off. Never shown to players otherwise. */
const TIMING_LS = "disciple.tradeTiming";
function timingBoxOn(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("timing");
    if (q === "1") localStorage.setItem(TIMING_LS, "1"); else if (q === "0") localStorage.removeItem(TIMING_LS);
    return localStorage.getItem(TIMING_LS) === "1";
  } catch { return false; }
}
if (typeof window !== "undefined") guarded(() => { timingBoxOn(); });   // remember ?timing=1 before the engine rewrites the URL
function showTimingBox(row: Record<string, unknown>) { guarded(() => {
  if (typeof document === "undefined" || !timingBoxOn()) return;
  const n = (v: unknown) => (typeof v === "number" ? `${Math.round(v)}` : "-");
  const srv = (row.server ?? {}) as Record<string, number>;
  const top = Object.entries(srv).filter(([, v]) => typeof v === "number" && v >= 20).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${Math.round(v)}`).join(" · ");
  pushTimingBox(`${new Date().toLocaleTimeString()} ${String(row.side)} ${row.ok ? "ok" : String(row.reason ?? "fail")}\n` +
    `send ${n(row.tapToRequestStart)} · 1st byte ${n(row.tapToFirstByte)} · pending ${n(row.tapToPendingFrame)} · confirmed ${n(row.tapToConfirmedFrame)} · receipt ${n(row.tapToReceipt)} · filled ${n(row.tapToFill)} ms\n` +
    `server${row.via ? ` (${String(row.via)})` : ""}: ${top || "-"}`);
}); }
function pushTimingBox(line: string) {
  let el = document.getElementById("disciple-trade-timing");
  if (!el) {
    el = document.createElement("pre"); el.id = "disciple-trade-timing";
    el.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:520px;max-height:50vh;overflow:auto;margin:0;padding:8px 10px;background:rgba(0,0,0,.88);color:#9f9;font:11px/1.35 ui-monospace,monospace;border-radius:8px;white-space:pre-wrap";
    document.body.appendChild(el);
  }
  el.textContent = `${line}\n\n${el.textContent ?? ""}`.slice(0, 5000);
}

/** The gasless (Permit2 witness) trade path's split for the ?timing=1 box: build + sign in the browser, the Privy token
 *  wait, and the /api/gasless round trip with the relay's own stages (lib/wallet execGasless). */
export function showGaslessTiming(x: { side: string; presigned?: boolean; sign: number; token: number; relay: number; t?: Record<string, number>; via?: string; server?: unknown }) { guarded(() => {
  if (typeof document === "undefined" || !timingBoxOn()) return;
  const r = (v: unknown) => (typeof v === "number" ? String(Math.round(v)) : "-");
  const srv = (x.server && typeof x.server === "object" ? x.server : {}) as Record<string, number>;
  const top = Object.entries(srv).filter(([k, v]) => typeof v === "number" && v >= 15 && k !== "elapsed" && k !== "instanceReq" && k !== "instanceAgeS").sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${Math.round(v)}`).join(" · ");
  const t = x.t ?? {};
  pushTimingBox(`${new Date().toLocaleTimeString()} gasless ${x.side} (${x.via ?? "?"})\n` +
    `browser sign ${x.presigned ? "pre-signed " : ""}${r(x.sign)} · token ${r(x.token)} · relay ${r(x.relay)} ms\n` +
    `relay: admission ${r(t.admission)} · budget ${r(t.budget)} · send+mined ${r(t.send)} · total ${r(t.total)} ms\n` +
    `stages: ${top || "-"}` +
    (typeof srv.instanceReq === "number" ? `\nserver instance: request #${srv.instanceReq} · up ${r(srv.instanceAgeS)} s` : ""));
}); }

/**
 * GAME trade speed (maker lee 2026-10-24: "3 seconds is unacceptable. we will only accept ms"; no optimistic / fake fills).
 * Pure helpers (no viem, no DOM) shared by components/TradeBridge.tsx and scripts/test-trade-speed.mjs:
 *  · receipt logs handed over by lib/wallet.execCalls (the disciple_sendUserOperationSync / fast-relay response, or the
 *    standard path's userOp receipt, already carries them) so the fill is decoded at "✓ done" with NO second
 *    waitForTransactionReceipt poll;
 *  · the "✓ done" status line, which shows the FILLED $ (decoded from the logs), not the pre-trade estimate;
 *  · click → confirm → fill timing marks for the 'disciple:op' {phase:"filled"} event.
 */
import type { DecodedFill, LogLike } from "./fills";

/* ---------------- receipt logs from the send response ---------------- */
const RECEIPTS = new Map<string, LogLike[]>();
/** Called by lib/wallet.execCalls with the receipt logs the send already returned (keyed by tx hash, last 32 kept). Synchronous, never throws. */
export function noteReceipt(txHash: string | undefined, logs: readonly LogLike[] | undefined) {
  // sync + no-throw: on the trade hot path (lib/wallet.execCalls); logs stored as returned, no RPC.
  try {
    if (typeof txHash !== "string" || !txHash || !Array.isArray(logs)) return;
    RECEIPTS.set(txHash.toLowerCase(), logs.slice());
    while (RECEIPTS.size > 32) RECEIPTS.delete(RECEIPTS.keys().next().value as string);
  } catch { /* the caller's trade result never depends on this */ }
}
/** The returned logs for this tx (once: removed on read). undefined ⇒ none came back ⇒ caller falls back to polling. */
export function takeReceipt(txHash: string | undefined): LogLike[] | undefined {
  if (!txHash) return undefined;
  const k = txHash.toLowerCase(), l = RECEIPTS.get(k); RECEIPTS.delete(k); return l;
}

/* ---------------- status line ---------------- */
/** Trade bar status after the result: "✓ done" shows the decoded FILL $ (what really moved), else the shot $ (no fill decoded
 *  yet: slow path polls in the background); failures keep the reason. fmt = lib/pnl fmtMoney. */
export function doneLine(side: "buy" | "sell", estUsd: number, r: { ok: boolean; reason?: string }, fill: Pick<DecodedFill, "side" | "usd"> | null | undefined, fmt: (v: number) => string) {
  const arrow = side === "buy" ? "▲" : "▼";
  if (!r.ok) return `${arrow} ${fmt(estUsd)} ✕ ${r.reason || "failed"}`;
  const usd = fill && fill.side === side && Number.isFinite(fill.usd) && fill.usd >= 0 ? fill.usd : estUsd;
  return `${arrow} ${fmt(usd)} ✓ done`;
}

/* ---------------- timing ---------------- */
export interface OpMark { submittedAt?: number; confirmedAt?: number; txHash?: string; timings?: unknown }
/** userOpHash → its disciple:op phase times (performance.now); txHash looked up on the confirmed mark. Last 32 kept. */
export class OpMarks {
  private m = new Map<string, OpMark>();
  note(d: { phase?: string; userOpHash?: string; txHash?: string; at?: number; timings?: unknown } | null | undefined) {
    if (!d || (d.phase !== "submitted" && d.phase !== "confirmed")) return;
    const k = String(d.userOpHash || d.txHash || "").toLowerCase(); if (!k) return;
    const cur = this.m.get(k) || {};
    if (d.phase === "submitted") cur.submittedAt ??= d.at; else { cur.confirmedAt = d.at; cur.timings = d.timings; }
    if (d.txHash) cur.txHash = String(d.txHash).toLowerCase();
    this.m.set(k, cur); while (this.m.size > 32) this.m.delete(this.m.keys().next().value as string);
  }
  byTx(txHash: string | undefined): OpMark | undefined {
    if (!txHash) return undefined; const t = txHash.toLowerCase();
    for (const v of this.m.values()) if (v.txHash === t) return v;
    return undefined;
  }
}
export interface TradeMs { quote?: number; submit?: number; confirm?: number; fill?: number; total: number }
/** ms from the click (bridge entry) to: amountIn/quote ready, op submitted, confirmed (receipt back), fill decoded. */
export function tradeMs(t0: number, m: { quoteAt?: number; op?: OpMark; resultAt?: number; fillAt?: number }): TradeMs {
  const d = (x?: number) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x - t0) : undefined);
  const confirm = d(m.op?.confirmedAt) ?? d(m.resultAt);
  return { quote: d(m.quoteAt), submit: d(m.op?.submittedAt), confirm, fill: d(m.fillAt), total: d(m.fillAt ?? m.resultAt) ?? 0 };
}

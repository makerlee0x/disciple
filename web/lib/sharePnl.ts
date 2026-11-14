/**
 * Per-position PnL for share cards, built on lib/pnl.ts (average-cost ledger).
 *   entry = the wallet's FIRST buy of the coin (earlier sells/transfers are ignored)
 *   still holding → end = `now` (moment of share) at the current mcap  → kind "unrealized" (realized so far + uPnL)
 *   sold everything → end = final sell, mcap after that sell            → kind "realized"
 * gainPct = gain / total $ bought (incl. fees). Gas is not on the Trade event, so it is excluded (gas = 0).
 */
import { applyFill, emptyPosition, view, FEE } from "./pnl";
import { TOTAL_SUPPLY_TOKENS, type Fill } from "./trades";

export interface PositionPnl {
  wallet: string;
  coin: string;
  kind: "unrealized" | "realized" | "none";
  gainUsd: number;
  gainPct: number;
  /** $ bought in total (cost) */
  investedUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  /** tokens still held per the ledger */
  holding: number;
  /** coin mcap at the end point */
  mcapEndUsd: number;
  mcapStartUsd: number;
  startTs: number;
  endTs: number;
  fills: Fill[];
}

/**
 * Where the LAST trade starts (maker 2026-11-14: "the whole trade from entry to exit"): the buy that opened the position that is
 * open now, or, if everything is sold, the buy that opened the last closed one. Earlier round trips on the same coin are left out.
 * -1 = no buy. Pure (scripts/test-share-pnl).
 */
export function lastTradeStart(sorted: readonly Fill[]): number {
  let held = 0, start = -1;
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    if (f.side === "buy") { if (held <= 1e-9) start = i; held += f.tokens; }
    else held = Math.max(0, held - f.tokens);
  }
  return start;
}

export function pnlFromFills(wallet: string, coin: string, all: Fill[], nowMcapUsd: number | null, now = Date.now(), opts: { trade?: "all" | "last" } = {}): PositionPnl {
  const sorted = [...all].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex || a.ts - b.ts);
  const first = opts.trade === "last" ? lastTradeStart(sorted) : sorted.findIndex((f) => f.side === "buy");
  const fills = first < 0 ? [] : sorted.slice(first);
  const base: PositionPnl = { wallet, coin, kind: "none", gainUsd: 0, gainPct: 0, investedUsd: 0, realizedUsd: 0, unrealizedUsd: 0, holding: 0, mcapEndUsd: nowMcapUsd ?? 0, mcapStartUsd: 0, startTs: 0, endTs: 0, fills };
  if (!fills.length) return base;
  let p = emptyPosition(), invested = 0;
  for (const f of fills) {
    if (f.tokens <= 0 || f.usd <= 0) continue;
    // Feed applyFill a price that reproduces the on-chain token amount exactly (buys: tokens = usd·(1−FEE)/price).
    const price = f.side === "buy" ? (f.usd * (1 - FEE)) / f.tokens : f.usd / f.tokens;
    if (f.side === "buy") invested += f.usd;
    p = applyFill(p, f.side, f.usd, price, 0, f.ts);
  }
  const last = fills[fills.length - 1];
  const holding = p.size;
  const open = holding > 1e-9;
  const mcapEnd = open ? (nowMcapUsd ?? last.mcapUsd) : last.mcapUsd;
  const mark = mcapEnd / TOTAL_SUPPLY_TOKENS;
  const v = view(p, mark, TOTAL_SUPPLY_TOKENS, open ? now : last.ts);
  const realized = p.realized - (p.fees || 0);
  const gain = realized + v.uPnl;
  return {
    ...base,
    kind: open ? "unrealized" : "realized",
    gainUsd: gain, gainPct: invested > 0 ? (gain / invested) * 100 : 0, investedUsd: invested,
    realizedUsd: realized, unrealizedUsd: v.uPnl, holding,
    mcapEndUsd: mcapEnd, mcapStartUsd: fills[0].mcapUsd,
    startTs: fills[0].ts, endTs: open ? now : last.ts,
  };
}

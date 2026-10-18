/**
 * Average-cost-basis position ledger (paper now; vault/indexer later via
 * ProtocolClient.getPosition).
 *
 * Invariants (maker lee):
 *   uPnL     = holdings × (mark − avgEntry)            avgEntry = costBasis / size (buy fee + gas included)
 *   realized += exactly the uPnL portion closed by a sell  = tokens × (fillPrice − avgEntry)
 *   exit fee + sell gas are booked separately in `fees` (they are costs of the exit, not price PnL),
 *   so a rising mark with size > 0 always means rising uPnL, and a sell at the mark moves PnL from
 *   uPnL into realized one-for-one.
 */
import { CURVE, GAS, holdBonus } from "./config";

export const FEE = CURVE.tradeFeeBps / 10_000;

export interface Position {
  /** token units */
  size: number;
  /** $ paid incl. fees + gas for the current size */
  costBasis: number;
  /** $ realized on sells (net of fees + gas) */
  realized: number;
  /** $ exit fees + sell gas paid (kept out of realized so realized == closed uPnL) */
  fees?: number;
  /** ms timestamp continuous holding started (0 = flat) */
  holdStart: number;
  /** partial sells scale the hold bonus down proportionally */
  sellScale: number;
  /** token supply the sizes were booked with (mcap ↔ price); a different mark supply rescales size on load */
  supply?: number;
  /** ephemeral market session (mock replay); a position from another session is dropped */
  session?: string | null;
}

/** DISCIPLE total supply (lib/sim/config TOTAL_SUPPLY); every source defaults to it. */
export const DEFAULT_SUPPLY = 7_000_000_000;

/** Re-express a stored position under the mark's supply (same $ cost basis and same entry MCAP). */
export function rebase(p: Position, supply: number): Position {
  const s0 = p.supply || supply;
  if (!(supply > 0) || s0 === supply || !(p.size > 0)) return { ...p, supply };
  return { ...p, size: p.size * (supply / s0), supply };
}

export const emptyPosition = (): Position => ({ size: 0, costBasis: 0, realized: 0, fees: 0, holdStart: 0, sellScale: 1 });

/**
 * Book a First BOOST (creator buy inside the launch tx) into the coin's PnL ledger with its EXACT fill: tokens received
 * and $ paid (fees included). Bug #4: it was never booked, so the creator's HUD showed nothing (or a stale/paper bag)
 * while the tokens sat in another wallet. Only seeds an empty ledger (never double-books).
 */
export function seedCreatorBuyPosition(storageKey: string, tokens: number, usd: number, supply = DEFAULT_SUPPLY, at = Date.now()): Position | null {
  if (!(tokens > 0) || !(usd > 0)) return null;
  try {
    const cur = JSON.parse(localStorage.getItem(storageKey) || "null") as Position | null;
    if (cur && cur.size > 0) return null;
    const p: Position = { ...emptyPosition(), size: tokens, costBasis: usd + gasUsd(), holdStart: at, supply };
    localStorage.setItem(storageKey, JSON.stringify({ ...p, session: null }));
    return p;
  } catch { return null; }
}

export function gasUsd(): number {
  return GAS.execGas * GAS.robinhoodGwei * 1e-9 * GAS.ethUsd;
}

/** Apply a fill. usd = gross notional; price = $ per token at fill.
 *  frac (sells): close exactly that fraction of the bag (a "50%" button sells half the TOKENS, whatever the fill price);
 *  otherwise tokens = usd / price. A sell never exceeds holdings; selling with no holdings is a no-op. */
export function applyFill(p: Position, side: "buy" | "sell", usd: number, price: number, gas = gasUsd(), at = Date.now(), sellFrac?: number): Position {
  const q = { ...p };
  if (price <= 0 || usd <= 0) return q;
  if (side === "buy") {
    const tokens = (usd * (1 - FEE)) / price;
    if (q.size <= 0) { q.holdStart = at; q.sellScale = 1; }
    q.size += tokens;
    q.costBasis += usd + gas;
  } else {
    if (q.size <= 0) return q;
    const tokens = sellFrac && sellFrac > 0 ? q.size * Math.min(1, sellFrac) : Math.min(q.size, usd / price);
    const frac = tokens / q.size;
    const basisOut = q.costBasis * frac;
    q.realized += tokens * price - basisOut;                 // = closed uPnL at this price
    q.fees = (q.fees || 0) + tokens * price * FEE + gas;     // exit cost, shown separately
    q.costBasis -= basisOut;
    q.size -= tokens;
    q.sellScale *= 1 - frac;
    if (q.size <= 1e-12) { q.size = 0; q.costBasis = 0; q.holdStart = 0; q.sellScale = 1; }
  }
  return q;
}

/** Shared PnL money/percent formatting (HUD, rocket tag, bottom bar, toasts).
 *  $ always 2 decimals; ≥ $1K compact with 2 decimals ($1.23K / $4.56M / $7.89B / $1.00T). Percent: 1 decimal. */
export function fmtMoney(v: number): string {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  const n = a >= 1e12 ? (a / 1e12).toFixed(2) + "T" : a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? (a / 1e3).toFixed(2) + "K" : a.toFixed(2);
  return s + "$" + n;
}
/** Signed: "+$0.11" / "−$0.11"; zero (and −0.00 after rounding) shows "+$0.00". */
export function fmtPnl(v: number): string { return (v < 0 && Math.abs(v) >= 0.005 ? "−" : "+") + fmtMoney(Math.abs(v)); }
export function fmtPct(v: number): string { return (v < 0 && Math.abs(v) >= 0.05 ? "−" : "+") + Math.abs(v).toFixed(1) + "%"; }

export interface PositionView {
  size: number;
  valueUsd: number;
  avgEntryUsd: number;
  entryMcap: number;
  pnlPct: number;
  uPnl: number;
  realized: number;
  fees: number;
  bonus: number;
}

/** Mark-to-market: uPnL = size × (mark − avgEntry). valueUsd = size × mark (gross, before the exit fee). */
export function view(p: Position, price: number, supply: number, now = Date.now()): PositionView {
  const valueUsd = p.size * price;
  const avg = p.size > 0 ? p.costBasis / p.size : 0;
  const uPnl = p.size > 0 ? p.size * (price - avg) : 0;
  const held = p.holdStart ? (now - p.holdStart) / 3.6e6 : 0;
  return {
    size: p.size, valueUsd, avgEntryUsd: avg, entryMcap: avg * supply,
    pnlPct: p.costBasis > 0 ? (uPnl / p.costBasis) * 100 : 0,
    uPnl, realized: p.realized, fees: p.fees || 0,
    bonus: holdBonus(uPnl, held, p.sellScale, valueUsd),
  };
}

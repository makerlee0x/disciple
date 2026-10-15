/**
 * Average-cost-basis position ledger (paper now; vault/indexer later via
 * ProtocolClient.getPosition). Fees (1% hook/protocol fee) and gas are in cost basis.
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
  /** ms timestamp continuous holding started (0 = flat) */
  holdStart: number;
  /** partial sells scale the hold bonus down proportionally */
  sellScale: number;
}

export const emptyPosition = (): Position => ({ size: 0, costBasis: 0, realized: 0, holdStart: 0, sellScale: 1 });

export function gasUsd(): number {
  return GAS.execGas * GAS.robinhoodGwei * 1e-9 * GAS.ethUsd;
}

/** Apply a fill. usd = gross notional; price = $ per token at fill. */
export function applyFill(p: Position, side: "buy" | "sell", usd: number, price: number, gas = gasUsd(), at = Date.now()): Position {
  const q = { ...p };
  if (price <= 0 || usd <= 0) return q;
  if (side === "buy") {
    const tokens = (usd * (1 - FEE)) / price;
    if (q.size <= 0) { q.holdStart = at; q.sellScale = 1; }
    q.size += tokens;
    q.costBasis += usd + gas;
  } else {
    if (q.size <= 0) return q;
    const tokens = Math.min(q.size, usd / price);
    const frac = tokens / q.size;
    const proceeds = tokens * price * (1 - FEE) - gas;
    const basisOut = q.costBasis * frac;
    q.realized += proceeds - basisOut;
    q.costBasis -= basisOut;
    q.size -= tokens;
    q.sellScale *= 1 - frac;
    if (q.size <= 1e-12) { q.size = 0; q.costBasis = 0; q.holdStart = 0; q.sellScale = 1; }
  }
  return q;
}

export interface PositionView {
  size: number;
  valueUsd: number;
  avgEntryUsd: number;
  entryMcap: number;
  pnlPct: number;
  uPnl: number;
  realized: number;
  bonus: number;
}

/** Mark-to-market (value net of the 1% exit fee). */
export function view(p: Position, price: number, supply: number, now = Date.now()): PositionView {
  const valueUsd = p.size * price * (1 - FEE);
  const avg = p.size > 0 ? p.costBasis / p.size : 0;
  const uPnl = p.size > 0 ? valueUsd - p.costBasis : 0;
  const held = p.holdStart ? (now - p.holdStart) / 3.6e6 : 0;
  return {
    size: p.size, valueUsd, avgEntryUsd: avg, entryMcap: avg * supply,
    pnlPct: p.costBasis > 0 ? (uPnl / p.costBasis) * 100 : 0,
    uPnl, realized: p.realized,
    bonus: holdBonus(uPnl, held, p.sellScale, valueUsd),
  };
}

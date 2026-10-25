/**
 * Pure TURBO position math (shared by the mock adapter and the unit tests; a real adapter may use the venue's own
 * numbers instead). All amounts in $. `feeBps` = fee per side in basis points of notional. `liqLossFrac` = share of
 * collateral that may be lost (after fees and funding) before liquidation, e.g. 0.8 → liquidated when only 20% is left.
 */
import type { Side } from "./types";

export const feeUsd = (notionalUsd: number, feeBps: number): number => (notionalUsd * feeBps) / 1e4;

/** Notional at the current price: sizeUsd scales with price / entry. */
export const notionalAt = (sizeUsd: number, entry: number, price: number): number => (sizeUsd * price) / entry;

/** PnL from the price move only. */
export function pricePnlUsd(side: Side, sizeUsd: number, entry: number, price: number): number {
  const r = price / entry - 1;
  return side === "long" ? sizeUsd * r : -sizeUsd * r;
}

export interface PnlInput {
  side: Side;
  sizeUsd: number;
  entry: number;
  price: number;
  openFeeUsd: number;
  fundingUsd: number;
  feeBps: number;
}

export function pnlBreakdown(p: PnlInput): { pnlUsd: number; closeFeeUsdEst: number; pnlAfterFeesUsd: number } {
  const pnlUsd = pricePnlUsd(p.side, p.sizeUsd, p.entry, p.price);
  const closeFeeUsdEst = feeUsd(notionalAt(p.sizeUsd, p.entry, p.price), p.feeBps);
  return { pnlUsd, closeFeeUsdEst, pnlAfterFeesUsd: pnlUsd - p.openFeeUsd - closeFeeUsdEst + p.fundingUsd };
}

export interface LiqInput {
  side: Side;
  collateralUsd: number;
  sizeUsd: number;
  entry: number;
  openFeeUsd: number;
  fundingUsd: number;
  feeBps: number;
  liqLossFrac: number;
}

/**
 * Liquidation price INCLUDING fees: the price where pnl − openFee − closeFee(at that price) + funding = −liqLossFrac × C.
 * Long:  x = P/E,  N·x·(1−f) = N − kC + open − funding
 * Short:           N·x·(1+f) = N + kC − open + funding
 * Clamped at 0 for longs. If the result is already past the entry, the position is liquidated at once (fees too high).
 */
export function liquidationPrice(p: LiqInput): number {
  const N = p.sizeUsd, f = p.feeBps / 1e4, kC = p.liqLossFrac * p.collateralUsd;
  if (N <= 0 || p.entry <= 0) return 0;
  const x = p.side === "long"
    ? (N - kC + p.openFeeUsd - p.fundingUsd) / (N * (1 - f))
    : (N + kC - p.openFeeUsd + p.fundingUsd) / (N * (1 + f));
  return Math.max(0, p.entry * x);
}

export const isLiquidated = (side: Side, price: number, liqPrice: number): boolean =>
  side === "long" ? price <= liqPrice : price >= liqPrice;

/** Funding for a time step. rate = fraction of notional per hour; + means longs pay shorts. Returns $ (+ = received). */
export function fundingDeltaUsd(side: Side, notionalUsd: number, ratePerHour: number, dtMs: number): number {
  const paidByLong = notionalUsd * ratePerHour * (dtMs / 3_600_000);
  return side === "long" ? -paidByLong : paidByLong;
}

/** What closing `frac` (0..1] of a position pays back, after that slice's open fee, its close fee and its funding. */
export function closeSlice(p: PnlInput & { collateralUsd: number }, frac: number): { returnedUsd: number; closeFeeUsd: number; pnlAfterFeesUsd: number } {
  const b = pnlBreakdown(p);
  const pnlAfterFeesUsd = b.pnlAfterFeesUsd * frac;
  return { returnedUsd: Math.max(0, p.collateralUsd * frac + pnlAfterFeesUsd), closeFeeUsd: b.closeFeeUsdEst * frac, pnlAfterFeesUsd };
}

/** Deterministic PRNG for the mock random walk (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random-walk step: price × exp(σ·z), z ~ N(0,1) via Box-Muller. */
export function walkStep(price: number, sigma: number, rand: () => number): number {
  const u = Math.max(rand(), 1e-12), v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return price * Math.exp(sigma * z);
}

/**
 * Per-market trading parameters, shaped like Nova's "Markets and parameters" page (docs.nova.markets, read Nov 13 2026),
 * so the play sample behaves like the real thing and Nova's adapter can hand back the same shape (MarketInfo.params).
 *
 * BTC / ETH at 1000× are not on Nova's public list yet (maker, Nov 13 2026: Nova's devs confirmed they will have 1000×).
 * Until they send the real numbers, these copy Nova's HYPE1000/USD market (1 bp a side, no fixed spread, 80% threshold,
 * $500 minimum position, 100k USDC OI cap). Every value marked CONFIRM is a hand-off question.
 */
import type { Market } from "./types";

export interface MarketParams {
  /** Open and close fee, each side, bps of notional. CONFIRM */
  feeBps: number;
  /** Fixed spread, bps of price, paid half on entry and half on exit. CONFIRM */
  spreadBps: number;
  /** Dynamic price impact: bps per $100k of notional, each side. CONFIRM (Nova: size, depth and OI skew) */
  impactBpsPer100k: number;
  /** Share of collateral lost (fees included) at which the position liquidates. CONFIRM */
  liqThreshold: number;
  /** Smallest position, $ notional (collateral × leverage). CONFIRM */
  minPositionUsd: number;
  /** Open-interest cap per market, $ notional. CONFIRM */
  oiCapUsd: number;
  minLeverage: number;
  maxLeverage: number;
  /** Borrowing fee to the pool, fraction of notional per hour. CONFIRM */
  borrowRatePerHour: number;
  /** Funding between traders, fraction of notional per hour, + = longs pay. CONFIRM (live, skew-based on Nova) */
  fundingRatePerHour: number;
  /** Time from tap to a confirmed fill (oracle round: 3 of 5 nodes). CONFIRM */
  fillMs: number;
  /** A market order nobody answers can be claimed back after this long (Nova: about 50 s). */
  claimBackMs: number;
}

const HYPE1000_LIKE: MarketParams = {
  feeBps: 1, spreadBps: 0, impactBpsPer100k: 0.2, liqThreshold: 0.8, minPositionUsd: 500, oiCapUsd: 100_000,
  minLeverage: 100, maxLeverage: 1000, borrowRatePerHour: 0.000005, fundingRatePerHour: 0.00001, fillMs: 1500, claimBackMs: 50_000,
};

export const STAND_IN_PARAMS: Record<Market, MarketParams> = { BTC: { ...HYPE1000_LIKE }, ETH: { ...HYPE1000_LIKE } };

/** Execution cost per side in bps: fee + half the fixed spread + impact for this notional. */
export function sideCostBps(p: MarketParams, notionalUsd: number): number {
  return p.feeBps + p.spreadBps / 2 + p.impactBpsPer100k * (Math.max(0, notionalUsd) / 100_000);
}

/** Smallest fuel that clears the minimum position at a leverage. */
export const minFuelAt = (p: MarketParams, leverage: number): number => (leverage > 0 ? p.minPositionUsd / leverage : Infinity);

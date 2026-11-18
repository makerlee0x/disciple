/**
 * Lighter order math (pure, no I/O). Lighter takes sizes and prices as integers scaled by each market's
 * size_decimals / price_decimals (GET /api/v1/orderBookDetails), fees as millionths of trade value, and leverage as an
 * initial-margin fraction out of 10,000.
 */

/** Partner (integrator) fee units: fee = trade value × units / 1e6, so 100 = 1 bp and 10 = 0.1 bp. */
export const bpToFeeUnits = (bp: number) => Math.round(bp * 100);
/** Leverage → Lighter's margin fraction (10,000 / leverage). 50× → 200. */
export const levFraction = (lev: number) => Math.round(10_000 / lev);

export const toInt = (v: number, decimals: number) => Math.round(v * 10 ** decimals);
export const fromInt = (v: number, decimals: number) => v / 10 ** decimals;

/** Base size (scaled int) for a $ notional at a price, rounded DOWN so the order never spends more than asked. */
export function baseAmountFor(notionalUsd: number, price: number, sizeDecimals: number): number {
  if (!(notionalUsd > 0) || !(price > 0)) return 0;
  return Math.floor((notionalUsd / price) * 10 ** sizeDecimals + 1e-9);
}

/**
 * Worst price a market order may fill at (scaled int). Lighter market orders carry a price cap: a buy fills at or under
 * it, a sell at or over it. `slip` is a fraction (0.005 = 0.5%).
 */
export function worstPrice(price: number, isAsk: boolean, slip: number, priceDecimals: number): number {
  const p = isAsk ? price * (1 - slip) : price * (1 + slip);
  return isAsk ? Math.floor(p * 10 ** priceDecimals) : Math.ceil(p * 10 ** priceDecimals);
}

/** Lighter client order index must fit in 48 bits; ms timestamp × 16 + a small counter stays unique per account. */
let seq = 0;
export function clientOrderIndex(now = Date.now()): number {
  seq = (seq + 1) % 16;
  return (now * 16 + seq) % 2 ** 48;
}

/** Round-trip cost in bp a player pays on Lighter Plus with Disciple's partner fee on top (per side × 2). */
export const roundTripBp = (lighterBpPerSide: number, partnerBpPerSide: number) => 2 * (lighterBpPerSide + partnerBpPerSide);

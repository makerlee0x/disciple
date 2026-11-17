/**
 * Keeper reference price for a DISCIPLE pool (slim hook, 2026-11-17). The hook no longer tracks a price on-chain, so the
 * keeper passes LockedLP.flush(token, refSqrtP) and CreatorFeeHarvest.routeAtRef(token, past, refSqrtP) a time-weighted
 * average of the pool's own PoolManager Swap prices over the last REF_WINDOW_S. Both contracts refuse to act when spot is
 * more than 3% from it, so a pump just before the keeper's tx makes the keeper skip instead of adding liquidity or
 * selling at the pumped price.
 *
 * Pure (unit-tested): `twapSqrt` averages in log space (geometric mean of sqrtPriceX96 = arithmetic mean of ticks).
 */
export const REF_WINDOW_S = 30 * 60;

export type PricePoint = { ts: number; sqrtP: bigint };

/**
 * Geometric time-weighted mean of sqrtPriceX96 over [now − window, now]. `start` = the price held when the window
 * opened (before the first point), `points` = post-swap prices in time order inside the window. 0n when no price is known.
 */
export function twapSqrt(start: bigint, points: readonly PricePoint[], now: number, window = REF_WINDOW_S): bigint {
  const t0 = now - window;
  let prevT = t0, prevP = start, acc = 0, w = 0;
  let only: bigint | null = null, mixed = false;
  const add = (p: bigint, dt: number) => {
    if (!(p > BigInt(0) && dt > 0)) return;
    acc += Math.log(Number(p)) * dt; w += dt;
    if (only === null) only = p; else if (only !== p) mixed = true;
  };
  for (const pt of points) {
    if (pt.ts <= t0) { prevP = pt.sqrtP; continue; }
    const t = Math.min(pt.ts, now);
    add(prevP, t - prevT);
    prevT = t; prevP = pt.sqrtP;
  }
  add(prevP, now - prevT);
  if (w === 0) return prevP > BigInt(0) ? prevP : start;
  if (!mixed && only !== null) return only; // one price held all window: exact
  return BigInt(Math.round(Math.exp(acc / w)));
}

/** |(hi/lo)^2 − 1| in bps (same formula as LockedLP._deviationBps). */
export function deviationBps(a: bigint, b: bigint): number {
  if (a === b) return 0;
  if (a <= BigInt(0) || b <= BigInt(0)) return Number.POSITIVE_INFINITY;
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return Number((((hi * BigInt(10_000)) / lo) * hi) / lo - BigInt(10_000));
}

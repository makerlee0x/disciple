// Off-chain mirror of the hook's price rules (DiscipleHook._v2 / _concentrated / _shift and DisciplePrice).
// Everything is integer math with the same rounding, so the keeper predicts exactly what the hook will compute.

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const UINT256_MAX = (1n << 256n) - 1n;

export const SRC_V2 = 1;
export const SRC_V3 = 2;
export const SRC_V4 = 3;

/** DisciplePrice constants (frozen hook). */
export const HEARTBEAT = 3570n; // 59.5 min: keeper sends a heartbeat at this anchor age
export const HEARTBEAT_PAID_AFTER = 59n * 60n; // a request sent at this age or later is paid as a heartbeat
export const MOVE_BPS = 100n; // a 1% move is a paid refresh
export const LOCAL_AFTER = 2n * 3600n;
export const PUSH_RECOVERY_AGE = 20n * 60n;
export const REFUND_BPS = 12_000n;
export const MAX_PUSH_REFUND = 2_000_000_000_000_000n; // 0.002 ETH, cap on the carried cost per pool

/** Spot (X128, raw quote per raw coin) the hook derives from a pushed source state (a, b). 0 = refused. */
export function spotX128(kind: number, a: bigint, b: bigint, coinIs0: boolean): bigint {
  if (kind === SRC_V2) {
    const [rc, rq] = coinIs0 ? [a, b] : [b, a];
    if (rc === 0n || rq === 0n) return 0n;
    return (rq * Q128) / rc;
  }
  // v3 / v4: (sqrtPriceX96, L); the hook refuses values that do not fit uint160 / uint128
  if (a === 0n || a >= 1n << 160n || b >= 1n << 128n) return 0n;
  if (coinIs0) return (a * a) / (1n << 64n);
  return (((Q128 * Q96) / a) * Q96) / a;
}

/** v * 10^sh, as DiscipleHook._shift (an overflowing product reads as 0). */
export function shift(sh: number, v: bigint): bigint {
  if (sh < 0) return v / 10n ** BigInt(-sh);
  if (sh === 0) return v;
  const m = 10n ** BigInt(sh);
  return v > UINT256_MAX / m ? 0n : v * m;
}

/** DisciplePrice._moved with a configurable threshold in bps. */
export function moved(ref: bigint, price: bigint, bps: bigint = MOVE_BPS): boolean {
  if (ref === 0n) return true;
  const d = price > ref ? price - ref : ref - price;
  return (d * 10_000n) / ref >= bps;
}

/** Move in bps (for logs). */
export function moveBps(ref: bigint, price: bigint): number {
  if (ref === 0n) return Infinity;
  const d = price > ref ? price - ref : ref - price;
  return Number((d * 1_000_000n) / ref) / 100;
}

const WAD = 10n ** 18n;
const Q96 = 1n << 96n;
export const TOTAL_SUPPLY = 7_000_000_000n * WAD;

/** wad bigint → float */
export const wad = (x: bigint | string | null | undefined) => (x == null ? 0 : Number(BigInt(x)) / 1e18);

/** quote raw per token raw * 1e18 from sqrtPriceX96. */
export function priceWadFromSqrt(sqrtP: bigint, tokenIsC0: boolean): bigint {
  if (sqrtP === 0n) return 0n;
  return tokenIsC0 ? (sqrtP * sqrtP * WAD) >> 192n : (WAD * Q96 * Q96) / (sqrtP * sqrtP);
}

/** Full-precision mcap (USD WAD) straight from sqrtPriceX96 — avoids flooring priceWad, which is single-digit
 *  for 6-dec quotes (USDG) and under-reported mcap by up to ~15%. quoteUsdWad = USD WAD per 1e18 raw quote. */
export function mcapUsdFromSqrt(sqrtP: bigint, tokenIsC0: boolean, quoteUsdWad: bigint, supply = TOTAL_SUPPLY): bigint {
  if (sqrtP === 0n) return 0n;
  const mcapQuote = tokenIsC0 ? (sqrtP * sqrtP * supply) >> 192n : (supply * Q96 * Q96) / (sqrtP * sqrtP);
  return (mcapQuote * quoteUsdWad) / WAD;
}

/**
 * Graduation progress 0–100 from a USD mcap — the SAME formula as web/lib/mcap.ts graduationPct (live retest #4), equal to
 * the curve's progressBps() (tokensSold / sCurve): x·y = x0·y0, mcap ∝ 1/(y0 − sold)² ⇒
 * progress = (1 − √(M0/M)) / (1 − √(M0/Mgrad)). M0/Mgrad = the coin's LaunchTierContext startMcapUsd/graduationMcapUsd
 * (default $7K/$33K for coins indexed before that event existed). null when unknown.
 */
export function graduationPct(mcapUsd: number | null | undefined, startMcapUsd = 7_000, graduationMcapUsd = 33_000): number | null {
  if (mcapUsd == null || !Number.isFinite(mcapUsd)) return null;
  if (!(startMcapUsd > 0) || !(graduationMcapUsd > startMcapUsd)) return null;
  if (mcapUsd >= graduationMcapUsd) return 100;
  if (mcapUsd <= startMcapUsd) return 0;
  const p = (1 - Math.sqrt(startMcapUsd / mcapUsd)) / (1 - Math.sqrt(startMcapUsd / graduationMcapUsd));
  return Math.max(0, Math.min(100, p * 100));
}

export function mcapUsdWad(priceWad: bigint, quoteUsdWad: bigint): bigint {
  return (((priceWad * TOTAL_SUPPLY) / WAD) * quoteUsdWad) / WAD;
}

/** Virtual in-range quote reserve of a v4 pool (quote raw). */
export function virtualQuoteReserve(liquidity: bigint, sqrtP: bigint, tokenIsC0: boolean): bigint {
  if (sqrtP === 0n) return 0n;
  return tokenIsC0 ? (liquidity * sqrtP) / Q96 : (liquidity * Q96) / sqrtP;
}

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number; n: number };

/** Bucketed OHLC from (ts, price, volume) rows sorted by ts asc. Gaps are not filled. */
/** `prevClose`: last price before the first row (range-bounded queries), so the first candle still opens at it. */
export function candles(rows: { ts: number; price: number; vol: number }[], intervalSec: number, prevClose?: number | null): Candle[] {
  const out: Candle[] = [];
  for (const r of rows) {
    const t = Math.floor(r.ts / intervalSec) * intervalSec;
    const last = out[out.length - 1];
    if (!last || last.t !== t) out.push({ t, o: last ? last.c : prevClose ?? r.price, h: r.price, l: r.price, c: r.price, v: r.vol, n: 1 });
    else {
      last.h = Math.max(last.h, r.price);
      last.l = Math.min(last.l, r.price);
      last.c = r.price;
      last.v += r.vol;
      last.n += 1;
    }
    // open at prior close keeps candles continuous; widen h/l to include it
    const cur = out[out.length - 1];
    cur.h = Math.max(cur.h, cur.o);
    cur.l = Math.min(cur.l, cur.o);
  }
  return out;
}

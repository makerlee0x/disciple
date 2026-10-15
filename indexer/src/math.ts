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
export function candles(rows: { ts: number; price: number; vol: number }[], intervalSec: number): Candle[] {
  const out: Candle[] = [];
  for (const r of rows) {
    const t = Math.floor(r.ts / intervalSec) * intervalSec;
    const last = out[out.length - 1];
    if (!last || last.t !== t) out.push({ t, o: last ? last.c : r.price, h: r.price, l: r.price, c: r.price, v: r.vol, n: 1 });
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

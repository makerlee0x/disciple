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

/**
 * Raw price (quote raw per token raw) at the MIDDLE of a tramp/wall's tick range: 1.0001^((tickLower+tickUpper)/2),
 * flipped when the token is currency1. Same as web/lib/trampwalls/onchain.ts `priceAtTick(c, (lo + hi) / 2)` (the
 * range's geometric centre price), which GAME uses for a wall's order size $ (#86).
 */
export function midRangePrice(tickLower: number, tickUpper: number, tokenIsC0: boolean): number {
  const mid = (Number(tickLower) + Number(tickUpper)) / 2;
  return Math.exp((tokenIsC0 ? mid : -mid) * Math.log(1.0001));
}

/** currency0 is the lower address; native quote (address(0)) is always currency0. */
export const tokenIsCurrency0 = (token: string, quote: string | null | undefined) => BigInt(token) < BigInt(quote ?? 0);

/** USD size of a wall: tokens × the mid-range price × quote USD (tokens and quote both 18 decimals). */
export function wallUsd(tokenAmtRaw: bigint | string, tickLower: number, tickUpper: number, tokenIsC0: boolean, quoteUsd: number): number {
  return (Number(BigInt(tokenAmtRaw)) / 1e18) * midRangePrice(tickLower, tickUpper, tokenIsC0) * quoteUsd;
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

/**
 * DiscipleHook TVL. Reserves come from poolState (anchor marks the coin side).
 * ERC-6909 claims on PoolManager are the hook-wide cross-check.
 * getLiquidity and slot0 are not inputs: the hook keeps v4 liquidity at 0 and initializes price to 1.
 * Same formula as indexer/src/disciple.ts.
 */
import { DISCIPLE_POOL } from "./catalog";

export const Q128 = 1n << 128n;

export function tvlQuoteRaw(coinReserve: bigint, quoteReserve: bigint, anchorX128: bigint): bigint {
  if (anchorX128 > 0n) return quoteReserve + (coinReserve * anchorX128) / Q128;
  if (coinReserve > 0n) return quoteReserve * 2n;
  return quoteReserve;
}

/** quoteUsdWad = USD WAD per 1e18 raw quote. null when the quote has no known USD price. */
export function quoteRawToUsd(raw: bigint, quoteUsdWad: bigint | null | undefined): number | null {
  if (quoteUsdWad == null || quoteUsdWad <= 0n) return null;
  return Number((raw * quoteUsdWad) / 10n ** 18n) / 1e18;
}

export type PoolReserves = { coinReserve: bigint; quoteReserve: bigint; anchorX128: bigint; quoteUsdWad?: bigint | null };

type ReserveWord = bigint | number | string;

/** Tuple layout matches DiscipleHook.PoolView (viem often returns this). */
export type PoolStateTuple = readonly [
  coin: string,
  quote: string,
  live: boolean,
  local: boolean,
  graduated: boolean,
  creatorOn: boolean,
  coinReserve: ReserveWord,
  quoteReserve: ReserveWord,
  anchorX128: ReserveWord,
  ...rest: ReserveWord[],
];

/** Named fields, when the client returns an object instead of a tuple. */
export type PoolStateNamed = {
  coin: string;
  quote: string;
  live: boolean;
  coinReserve: ReserveWord;
  quoteReserve: ReserveWord;
  anchorX128: ReserveWord;
};

export type PoolStateRead = PoolStateTuple | PoolStateNamed;

function isNamedPoolState(v: PoolStateRead): v is PoolStateNamed {
  return !Array.isArray(v);
}

/** viem returns poolState as a named object or a tuple. Indexes match DiscipleHook.PoolView. */
export function reservesFromPoolState(v: PoolStateRead): { coin: string; quote: string; live: boolean; coinReserve: bigint; quoteReserve: bigint; anchorX128: bigint } {
  if (isNamedPoolState(v)) {
    return {
      coin: String(v.coin),
      quote: String(v.quote),
      live: Boolean(v.live),
      coinReserve: BigInt(v.coinReserve),
      quoteReserve: BigInt(v.quoteReserve),
      anchorX128: BigInt(v.anchorX128),
    };
  }
  return {
    coin: String(v[0]),
    quote: String(v[1]),
    live: Boolean(v[2]),
    coinReserve: BigInt(v[6]),
    quoteReserve: BigInt(v[7]),
    anchorX128: BigInt(v[8]),
  };
}

/** Quote-raw TVL and USD from poolState fields. */
export function tvlFromPoolState(v: PoolReserves): { tvlQuoteRaw: bigint; liquidityUsd: number | null } {
  const tvlQuoteRaw = tvlQuoteRawOf(v);
  return { tvlQuoteRaw, liquidityUsd: quoteRawToUsd(tvlQuoteRaw, v.quoteUsdWad === undefined ? DISCIPLE_POOL.quotePriceUsdWad : v.quoteUsdWad) };
}

function tvlQuoteRawOf(v: PoolReserves): bigint {
  return tvlQuoteRaw(v.coinReserve, v.quoteReserve, v.anchorX128);
}

/**
 * Home-feed liquidity. Only a number already computed from poolState / ERC-6909 (home payload).
 * Launchpad coins are not DiscipleHook pools, so this stays 0 — it never calls getLiquidity.
 */
export function liquidityUsdForHome(x: { liquidityUsd?: number | null }): number {
  const n = x.liquidityUsd;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

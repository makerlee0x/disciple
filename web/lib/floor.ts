/**
 * Graduation floor bins (LockedLP phase 3a, contracts/src/libraries/FloorBands.sol).
 *
 * At graduation LockedLP seeds `bands` (16) quote-only (USDG) positions just under the spot:
 *   layer A · bands 0..3  · 30% flat (7.5% each), 12 tick-spacings each: spot → 0.75x  ($33.3K → $25K mcap)
 *   layer B · bands 4..15 · 70% bottom-heavy (4x more at the bottom), 32 spacings each: spot → 0.1x ($33.3K → ≈$3.3K)
 * Both layers start at the base tick, so they overlap in price: the chart sums each layer's USDG per price bucket
 * (4-spacing buckets, the common grid of 12- and 32-spacing bands) and draws the two layers as separate series.
 * floorBands(token) returns each band's ticks + what it holds at the current pool price: quoteAmount = USDG still
 * resting, tokenAmount > 0 = the price has fallen into the band and it has bought coins.
 *
 * Pure helpers (no React) + one reader. mcap from a tick: price = 1.0001^tick (currency1 per currency0, raw units),
 * inverted when the token is currency1, × total supply (1M), in dollars via the curve's launch quote price.
 */
import type { Address, PublicClient } from "viem";
import { bondingCurveAbi, lockedLPAbi } from "./abi";
import { deployment, isDeployed } from "./chains";

export const FLOOR_SPACING = 60;
export const FLOOR_FLAT_BANDS = 4;
/** Band shares in bps of the floor (FloorBands.band): 4 × 750 flat, then BOTTOM_BPS_PACKED j = 0 (top) .. 11 (bottom). */
export const FLOOR_BAND_BPS = [750, 750, 750, 750, 266, 301, 342, 388, 440, 499, 566, 642, 728, 826, 937, 1065] as const;

export type FloorInfo = { baseTick: number; bands: number; quoteSeeded: bigint };
export type FloorBandRaw = { tickLower: number; tickUpper: number; liquidity: bigint; quoteAmount: bigint; tokenAmount: bigint };
export type FloorBin = {
  /** mcap range of the bucket (lo < hi, dollars) */
  mcapLo: number;
  mcapHi: number;
  /** dollars resting / seeded per layer in this bucket */
  top: number;
  bottom: number;
  topSeeded: number;
  bottomSeeded: number;
};
export type FloorView = {
  bins: FloorBin[];
  /** dollars resting per band (index = band) */
  bandUsd: number[];
  /** bands the price has fallen into (they hold coins) */
  soldInto: number;
  seededUsd: number;
  remainingUsd: number;
  topUsd: number;
  bottomUsd: number;
  /** 0..1 */
  remainingFrac: number;
  mcapMin: number;
  mcapMax: number;
};

/** token = currency0 ⇔ bands sit BELOW base (band 0's upper tick is the base). */
export const floorTokenIsC0 = (info: FloorInfo, bands: FloorBandRaw[]) => (bands.length ? bands[0].tickUpper === info.baseTick : true);

/**
 * Market cap in dollars at `tick`.
 * @param quoteUsd18 dollars per 1e18 raw quote units (BondingCurve.quotePriceUsd / 1e18; USDG = 1)
 * @param supply whole tokens (18 decimals), 1M on DISCIPLE
 */
export function mcapAtTick(tick: number, tokenIsC0: boolean, quoteUsd18 = 1, supply = 1e6): number {
  const p = Math.pow(1.0001, tick); // currency1 raw per currency0 raw
  const quotePerToken = tokenIsC0 ? p : 1 / p; // quote raw per token raw (= per whole token when both are 18-dec)
  return quotePerToken * quoteUsd18 * supply;
}
/** Inverse of mcapAtTick (fractional tick). */
export function tickAtMcap(mcap: number, tokenIsC0: boolean, quoteUsd18 = 1, supply = 1e6): number {
  const t = Math.log(mcap / supply / quoteUsd18) / Math.log(1.0001);
  return tokenIsC0 ? t : -t;
}

/** Bucket width in ticks: 4 spacings (gcd of the 12- and 32-spacing band widths). */
export const FLOOR_BIN_TICKS = 4 * FLOOR_SPACING;

/**
 * Sum USDG per price bucket for the two layers. Inside a band, resting USDG sits at its LOW-price end (a falling price
 * consumes a band from the top), so each band's quoteAmount is filled into its buckets from the bottom up, each bucket
 * holding at most its full-range capacity L·Δ√P (Δ(1/√P) when the quote is currency0).
 */
export function buildFloorView(info: FloorInfo, bands: FloorBandRaw[], quoteUsd18 = 1, supply = 1e6): FloorView | null {
  if (!info.bands || !bands.length) return null;
  const c0 = floorTokenIsC0(info, bands);
  const base = info.baseTick;
  const depth = (t: number) => (c0 ? base - t : t - base); // ticks below the base on the coin's price
  const tickAt = (d: number) => (c0 ? base - d : base + d);
  const sq = (t: number) => Math.pow(1.0001, t / 2);
  const cap = (L: number, d1: number, d2: number) => { // raw quote between depths d1 < d2
    const a = tickAt(d1), b = tickAt(d2);
    return c0 ? L * Math.abs(sq(a) - sq(b)) : L * Math.abs(1 / sq(a) - 1 / sq(b));
  };
  const maxD = Math.max(...bands.map((b) => Math.max(depth(b.tickLower), depth(b.tickUpper))));
  const n = Math.max(1, Math.ceil(maxD / FLOOR_BIN_TICKS));
  const usd = (raw: number) => (raw / 1e18) * quoteUsd18;
  const bins: FloorBin[] = Array.from({ length: n }, (_, k) => {
    const m1 = mcapAtTick(tickAt(k * FLOOR_BIN_TICKS), c0, quoteUsd18, supply), m2 = mcapAtTick(tickAt((k + 1) * FLOOR_BIN_TICKS), c0, quoteUsd18, supply);
    return { mcapLo: Math.min(m1, m2), mcapHi: Math.max(m1, m2), top: 0, bottom: 0, topSeeded: 0, bottomSeeded: 0 };
  });
  const seededTotal = usd(Number(info.quoteSeeded));
  bands.forEach((b, i) => {
    const top = i < FLOOR_FLAT_BANDS;
    const dA = Math.min(depth(b.tickLower), depth(b.tickUpper)), dB = Math.max(depth(b.tickLower), depth(b.tickUpper));
    const k0 = Math.floor(dA / FLOOR_BIN_TICKS), k1 = Math.ceil(dB / FLOOR_BIN_TICKS);
    let L = Number(b.liquidity);
    if (!(L > 0)) { // no liquidity reported: spread the layout share evenly in √P
      const share = (seededTotal * (FLOOR_BAND_BPS[i] ?? 0)) / 10_000 / quoteUsd18 * 1e18;
      L = share / Math.max(cap(1, dA, dB), 1e-30);
    }
    let left = Number(b.quoteAmount);
    for (let k = k1 - 1; k >= k0; k--) { // deepest (lowest price) bucket first
      const d1 = Math.max(dA, k * FLOOR_BIN_TICKS), d2 = Math.min(dB, (k + 1) * FLOOR_BIN_TICKS);
      if (d2 <= d1 || !bins[k]) continue;
      const c = cap(L, d1, d2), fill = Math.max(0, Math.min(c, left));
      left -= fill;
      if (top) { bins[k].top += usd(fill); bins[k].topSeeded += usd(c); } else { bins[k].bottom += usd(fill); bins[k].bottomSeeded += usd(c); }
    }
  });
  const bandUsd = bands.map((b) => usd(Number(b.quoteAmount)));
  const topUsd = bandUsd.slice(0, FLOOR_FLAT_BANDS).reduce((a, x) => a + x, 0);
  const bottomUsd = bandUsd.slice(FLOOR_FLAT_BANDS).reduce((a, x) => a + x, 0);
  const remainingUsd = topUsd + bottomUsd;
  const seededUsd = seededTotal > 0 ? seededTotal : bins.reduce((a, x) => a + x.topSeeded + x.bottomSeeded, 0);
  return {
    bins, bandUsd,
    soldInto: bands.filter((b) => b.tokenAmount > BigInt(0)).length,
    seededUsd, remainingUsd, topUsd, bottomUsd,
    remainingFrac: seededUsd > 0 ? Math.max(0, Math.min(1, remainingUsd / seededUsd)) : 0,
    mcapMin: Math.min(...bins.map((b) => b.mcapLo)),
    mcapMax: Math.max(...bins.map((b) => b.mcapHi)),
  };
}

const Z = /^0x0{40}$/i;
/** LockedLP address on the active chain when its ABI has the floor views, else null (chart hidden). */
export function floorLockedLP(): Address | null {
  if (!isDeployed()) return null;
  const a = deployment().lockedLP;
  if (!a || Z.test(a)) return null;
  const has = (n: string) => (lockedLPAbi as readonly { type?: string; name?: string }[]).some((x) => x.type === "function" && x.name === n);
  return has("floorInfo") && has("floorBands") ? a : null;
}

/**
 * Read the floor for a graduated coin. null = no floor to show (LockedLP not deployed / predates the floor so the
 * read reverts / bands = 0). `curve` is the coin's BondingCurve (for the launch quote price; USDG ⇒ $1 fallback).
 */
export async function readFloor(pc: PublicClient, token: Address, curve?: Address): Promise<FloorView | null> {
  const lp = floorLockedLP();
  if (!lp) return null;
  try {
    const [baseTick, bands, quoteSeeded] = (await pc.readContract({ address: lp, abi: lockedLPAbi, functionName: "floorInfo", args: [token] })) as readonly [number, number, bigint];
    if (!Number(bands)) return null;
    const [raw, qp] = await Promise.all([
      pc.readContract({ address: lp, abi: lockedLPAbi, functionName: "floorBands", args: [token] }) as Promise<readonly { tickLower: number; tickUpper: number; liquidity: bigint; quoteAmount: bigint; tokenAmount: bigint }[]>,
      curve ? (pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" }) as Promise<bigint>).catch(() => null) : Promise.resolve(null),
    ]);
    const quoteUsd18 = qp && qp > BigInt(0) ? Number(qp) / 1e18 : 1;
    return buildFloorView(
      { baseTick: Number(baseTick), bands: Number(bands), quoteSeeded: BigInt(quoteSeeded) },
      raw.map((b) => ({ tickLower: Number(b.tickLower), tickUpper: Number(b.tickUpper), liquidity: BigInt(b.liquidity), quoteAmount: BigInt(b.quoteAmount), tokenAmount: BigInt(b.tokenAmount) })),
      quoteUsd18,
    );
  } catch {
    return null; // pre-floor LockedLP (no floorInfo selector) or coin not on this LockedLP
  }
}

/**
 * Dev/test fixture: the real band geometry for a coin that graduated at `gradMcap` with `seeded` dollars in the floor
 * (token = currency0, $1 quote, 18 decimals), with the price now at `nowMcap` (bands above it have been sold into).
 */
export function floorFixture(gradMcap = 33_333, seeded = 1_201, nowMcap = 27_500): { info: FloorInfo; bands: FloorBandRaw[] } {
  const cur = Math.floor(tickAtMcap(gradMcap, true));
  let base = Math.trunc(cur / FLOOR_SPACING) * FLOOR_SPACING;
  if (cur < 0 && cur % FLOOR_SPACING !== 0) base -= FLOOR_SPACING;
  const sp = Math.pow(1.0001, tickAtMcap(nowMcap, true) / 2);
  const big = (x: number) => BigInt(Math.max(0, Math.round(x)));
  const bands: FloorBandRaw[] = FLOOR_BAND_BPS.map((bps, i) => {
    const [lo, hi] = i < FLOOR_FLAT_BANDS ? [12 * i, 12 * (i + 1)] : [32 * (i - 4), 32 * (i - 3)]; // FloorBands.band: both layers start at base
    const tickLower = base - hi * FLOOR_SPACING, tickUpper = base - lo * FLOOR_SPACING;
    const sa = Math.pow(1.0001, tickLower / 2), sb = Math.pow(1.0001, tickUpper / 2);
    const L = ((seeded * bps) / 10_000) * 1e18 / (sb - sa);
    const q = L * (Math.min(Math.max(sp, sa), sb) - sa); // amount1 resting (USDG)
    const t = sp >= sb ? 0 : L * (1 / Math.max(sp, sa) - 1 / sb); // amount0 bought (coins)
    return { tickLower, tickUpper, liquidity: big(L), quoteAmount: big(q), tokenAmount: big(t) };
  });
  return { info: { baseTick: base, bands: bands.length, quoteSeeded: big(seeded * 1e18) }, bands };
}

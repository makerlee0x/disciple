/**
 * Turbo → flight engine mapping (pure; unit-tested in scripts/test-turbo.mts).
 *
 * OVERRIDE (lee, Nov 12 2026 10:40 AM CT): altitude is the actual BTC or ETH market cap, the same path a live
 * DISCIPLE rocket already follows, whether or not a position is open. It is never profit / PnL. A short does not
 * flip or invert the sky. Profit after fees is a dollar figure on the ticket and HUD only.
 *
 * The liquidation line still sits in the sky at the market cap of the liquidation price (below a long, a ceiling
 * above a short) and pins to the edge when off-screen (engine drawTurboLines).
 */
import type { Market, Position, Side } from "./types";

/** Circulating supply used to turn a mid into market cap for the flight path (stand-in constants; supply changes slowly). */
export const CIRCULATING: Record<Market, number> = { BTC: 19_900_000, ETH: 120_700_000 };

/** Actual market cap ($) = mid price × circulating supply. */
export function marketCapUsd(market: Market, price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return NaN;
  return price * CIRCULATING[market];
}

/** Altitude with no open position (mid-sky; engine alt = tier index + position inside the tier). */
export const FLIGHT_BASE_ALT = 4.5;
/** Screen pixels per 100% of fuel won or lost: liquidation (−80% of fuel) starts ≈ 144 px from the rocket. */
export const FLIGHT_PX_PER_FUEL = 180;
/** The engine's altitude scale (engine.js PX_PER_ALT = 1.5 × 720 × 10 on load); TurboFlight passes the live value. */
export const ENGINE_PX_PER_ALT = 10_800;
/** Altitude per 100% of fuel at the default engine scale. */
export const FLIGHT_ALT_PER_FUEL = FLIGHT_PX_PER_FUEL / ENGINE_PX_PER_ALT;
export const FLIGHT_ALT_MIN = 0.4, FLIGHT_ALT_MAX = 9.6;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const dir = (s: Side) => (s === "long" ? 1 : -1);

/** Altitude for a PnL-after-fees on a position with `fuelUsd` fuel in. */
export function pnlToAlt(side: Side, pnlAfterFeesUsd: number, fuelUsd: number, pxPerAlt = ENGINE_PX_PER_ALT): number {
  if (!(fuelUsd > 0) || !Number.isFinite(pnlAfterFeesUsd)) return FLIGHT_BASE_ALT;
  const perFuel = FLIGHT_PX_PER_FUEL / (pxPerAlt > 0 ? pxPerAlt : ENGINE_PX_PER_ALT);
  return clamp(FLIGHT_BASE_ALT + dir(side) * (pnlAfterFeesUsd / fuelUsd) * perFuel, FLIGHT_ALT_MIN, FLIGHT_ALT_MAX);
}

/** Altitude of the red liquidation line: the PnL after fees the position would show AT its liquidation price. */
export function liqAltOf(p: Pick<Position, "side" | "entry" | "liqPrice" | "sizeUsd" | "collateralUsd" | "openFeeUsd" | "fundingUsd">, pxPerAlt = ENGINE_PX_PER_ALT): number {
  if (!(p.entry > 0) || !(p.liqPrice > 0)) return FLIGHT_ALT_MIN;
  const r = p.liqPrice / p.entry - 1;
  // Paid-fees-only PnL at the liquidation price, so the rocket and the red line meet when liq fires.
  const pnlAtLiq = (p.side === "long" ? 1 : -1) * p.sizeUsd * r - p.openFeeUsd + p.fundingUsd;
  return pnlToAlt(p.side, pnlAtLiq, p.collateralUsd, pxPerAlt);
}

/**
 * Danger = how far the price has moved from entry toward the liquidation price (0 = at entry or better, 1 = at the line).
 * 0.5 "Running hot", 0.8 shudder, 0.95 "About to blow!".
 */
export function dangerOf(p: Pick<Position, "side" | "entry" | "liqPrice" | "markPrice">): number {
  const mark = p.markPrice ?? p.entry;
  const span = p.side === "long" ? p.entry - p.liqPrice : p.liqPrice - p.entry;
  if (!(span > 0) || !(mark > 0)) return 0;
  const moved = p.side === "long" ? p.entry - mark : mark - p.entry;
  return clamp(moved / span, 0, 1);
}

export type DangerLevel = "calm" | "hot" | "shudder" | "blow";
export const dangerLevel = (d: number): DangerLevel => (d >= 0.95 ? "blow" : d >= 0.8 ? "shudder" : d >= 0.5 ? "hot" : "calm");

/** Jetstream strength from leverage: L = log10(lev) / 3 (10× ≈ 0.33, 100× ≈ 0.67, 1000× = 1). */
export const jetstreamL = (leverage: number) => clamp(Math.log10(Math.max(1, leverage)) / 3, 0, 1);

/** Share card trigger for a big win: any profit after fees. */
export const isBigWin = (profitUsd: number) => profitUsd > 0;

/* ---------------------------------------------------------------------------------------------------------------
 * Run-zoomed sky (maker, Nov 13 2026: "Zoom the sky to the run"). Replaces the Nov 12 rule that height = the whole
 * market cap. The sky is scaled to the run: the H-BOMB line sits SKY_LIQ_FRAC of the screen below the boarding line,
 * so a 0.06% move at 1000× is as visible as a 0.78% move at 100×. Market cap is still shown as a number.
 * With no run open, the same scale is previewed for the selected gear around a slowly re-centring anchor.
 * ------------------------------------------------------------------------------------------------------------- */

/** Mid-sky altitude the run is anchored at (engine alt units). */
export const SKY_BASE_ALT = 4.5;
/** Share of the screen height between the boarding line and the H-BOMB line. */
export const SKY_LIQ_FRAC = 0.16;

/** Pixel offset of a price from the anchor on the zoomed sky (+ = up). `liqDist` = |liq/entry − 1| (fraction). */
export function skyOffsetPx(price: number, anchor: number, liqDist: number, screenH: number): number {
  if (!(price > 0) || !(anchor > 0) || !(liqDist > 0) || !(screenH > 0)) return 0;
  return ((price / anchor - 1) / liqDist) * SKY_LIQ_FRAC * screenH;
}

/** Altitude on the zoomed sky for a price (engine alt units). */
export function skyAlt(price: number, anchor: number, liqDist: number, screenH: number, pxPerAlt: number): number {
  return SKY_BASE_ALT + skyOffsetPx(price, anchor, liqDist, screenH) / (pxPerAlt > 0 ? pxPerAlt : ENGINE_PX_PER_ALT);
}

/** |liq / entry − 1| as a fraction. */
export const liqDistance = (entry: number, liqPrice: number): number => (entry > 0 && liqPrice > 0 ? Math.abs(liqPrice / entry - 1) : 0);

/** Price where cashing out returns exactly the fuel put in (open fee, close fee and funding so far covered). */
export function breakEvenPrice(p: Pick<Position, "side" | "entry" | "sizeUsd" | "openFeeUsd" | "closeFeeUsdEst" | "fundingUsd">): number {
  if (!(p.entry > 0) || !(p.sizeUsd > 0)) return 0;
  const need = (p.openFeeUsd + p.closeFeeUsdEst - p.fundingUsd) / p.sizeUsd;
  return p.side === "long" ? p.entry * (1 + need) : p.entry * (1 - need);
}

/** Dollars back if the whole position were closed now (after the close fee). Never below 0. */
export const cashOutNowUsd = (p: Pick<Position, "collateralUsd" | "pnlAfterFeesUsd" | "closeFeeUsdEst">): number =>
  Math.max(0, p.collateralUsd + p.pnlAfterFeesUsd - p.closeFeeUsdEst);

/** v2.1: price where the run pays back `k` × the fuel put in (partial banks included), from the live cash-out value.
 *  Close-fee changes over the move are ignored (they are a rounding error at line scale). 0 when it can't be placed. */
export function multiplePrice(p: Pick<Position, "side" | "entry" | "sizeUsd" | "markPrice" | "collateralUsd" | "pnlAfterFeesUsd" | "closeFeeUsdEst">, fuelIn: number, realizedUsd: number, k = 2): number {
  const mark = p.markPrice ?? p.entry;
  if (!(p.entry > 0) || !(p.sizeUsd > 0) || !(mark > 0) || !(fuelIn > 0)) return 0;
  const need = k * fuelIn - realizedUsd - cashOutNowUsd(p);
  const px = mark + (p.side === "long" ? 1 : -1) * (p.entry * need) / p.sizeUsd;
  return px > 0 ? px : 0;
}

/** Annualised volatility used only for the "typical run" label on the gear tiles (not for any trade math). */
export const ANNUAL_VOL: Record<Market, number> = { BTC: 0.5, ETH: 0.65 };

/**
 * Typical (median) seconds before a price random walk first travels `liqDist` against you: (a/σ)² / (2·erfcinv(½)²).
 * A label for the gear tiles ("~1 min"), never a promise.
 */
export function typicalRunSeconds(market: Market, liqDist: number): number {
  const sigma = ANNUAL_VOL[market] / Math.sqrt(365 * 24 * 3600);
  if (!(liqDist > 0)) return 0;
  return (liqDist / sigma) ** 2 / 0.91;
}

export function paceLabel(seconds: number): string {
  if (!(seconds > 0)) return "";
  if (seconds < 90) return "~1 min";
  if (seconds < 3600) return `~${Math.max(2, Math.round(seconds / 300) * 5 || Math.round(seconds / 60))} min`;
  const h = Math.round(seconds / 3600);
  return `~${h} hr`;
}

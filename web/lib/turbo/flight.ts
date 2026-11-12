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

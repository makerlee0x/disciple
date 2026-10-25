/**
 * GAME graduation fix (maker lee 2026-10-24 7:04 PM CT, "graduation fix 1-3", item 3 = GAME). Pure helpers, no viem / DOM,
 * shared by components/TradeBridge.tsx, components/flight/PhoneTradeBar.tsx and scripts/test-grad-fix.mjs:
 *   1. price-move WARNINGS before a big trade (chip, picker sheet, trade bar): "Big move: price +38%" at ≥ BIG_MOVE_BPS, and
 *      "Too big for this rocket right now" when the quote is over the router's live max impact (SITE's
 *      readRouterMaxImpactBps via lib/flight/gradAdapter; NEVER hard-coded; 0 / null = no cap). Scope change from lee 7:09 PM CT: NOTHING is greyed, disabled or
 *      blocked for price impact, in any mode, and the warning is never a confirm dialog (rapid taps still send).
 *   2. one exact GRADUATE buy, sized from the curve + router (SITE's readGradNeedForToken usdgIn, via
 *      lib/flight/gradAdapter; no extra margin), never from the HUD's ≈ maths.
 *   3. plain trade error copy (no "router" / "slippage" / "minOut" / "gas").
 * Player copy below is PLACEHOLDER pending lee + BRAND, except OUT_OF_GAS (lee-approved).
 */
import type { TradeErrorKind } from "../protocol-viem";

/** SITE's stable trade-error kind (lib/protocol-viem tradeErrorKind). Type-only import: this module stays pure. */
export type TradeErrorCode = TradeErrorKind;

/** PLACEHOLDER copy (pending lee + BRAND). */
export const GAME_COPY = {
  /** warning on a chip / sheet option / trade bar when the quote is over the live router limit (likely to fail; NOT blocked) */
  overImpactHint: "Too big for this rocket right now",
  /** big-move warning prefix: "Big move: price +38%" */
  bigMove: "Big move: ",
  PRICE_IMPACT: "Too big for this rocket right now. Try a smaller amount.",
  MIN_OUT: "Price moved. Tap again.",
  /** lee-approved string (not a placeholder) */
  OUT_OF_GAS: "That didn't go through. Try again.",
} as const;

/** Plain line for a classified failure; null = keep the existing (already plain) message. */
export function plainTradeMessage(code: TradeErrorCode): string | null {
  return code === "OTHER" ? null : GAME_COPY[code];
}

/** A real cap is a positive finite bps value. 0 / null / NaN = no cap ("no-cap mode") ⇒ never an "over the limit" warning. */
export const hasImpactCap = (maxBps: number | null | undefined): maxBps is number => typeof maxBps === "number" && Number.isFinite(maxBps) && maxBps > 0;

/** Quote's |impact| above the live cap? Unknown impact or no cap ⇒ false. Only drives a WARNING (lee 7:09 PM CT: never block). */
export function overImpact(impactBps: number | null | undefined, maxBps: number | null | undefined): boolean {
  if (!hasImpactCap(maxBps)) return false;
  if (typeof impactBps !== "number" || !Number.isFinite(impactBps)) return false;
  return Math.abs(impactBps) > maxBps;
}

/** "Big move" warning threshold: |expected price move| ≥ 10% (1000 bps). Named so lee / BRAND can tune it. */
export const BIG_MOVE_BPS = 1000;

export type MoveWarn = { level: "none" | "big" | "over"; text: string; pct: number | null };
const NO_WARN: MoveWarn = { level: "none", text: "", pct: null };
/**
 * Pre-trade price-move warning for one amount (chip, picker option, trade bar). NEVER blocks or confirms: the trade
 * still sends with one tap (lee 7:09 PM CT). impactBps = the quote's expected price move (signed or not; side gives the sign).
 *   over the live router limit ⇒ "over": "Too big for this rocket right now · price +62%" (will likely fail)
 *   ≥ BIG_MOVE_BPS             ⇒ "big":  "Big move: price +38%"
 *   else / unknown             ⇒ "none"
 * PLACEHOLDER copy.
 */
export function moveWarning(side: "buy" | "sell", impactBps: number | null | undefined, maxBps: number | null | undefined, threshold = BIG_MOVE_BPS): MoveWarn {
  if (typeof impactBps !== "number" || !Number.isFinite(impactBps)) return NO_WARN;
  const abs = Math.abs(impactBps), pct = Math.round(abs / 100), move = `price ${side === "buy" ? "+" : "−"}${pct}%`;
  if (overImpact(abs, maxBps)) return { level: "over", text: `${GAME_COPY.overImpactHint} · ${move}`, pct };
  if (abs >= threshold) return { level: "big", text: `${GAME_COPY.bigMove}${move}`, pct };
  return NO_WARN;
}
/** One warning per amount (presets + custom). */
export const moveWarnings = (side: "buy" | "sell", impacts: readonly (number | null | undefined)[], maxBps: number | null | undefined, threshold = BIG_MOVE_BPS): MoveWarn[] =>
  impacts.map((b) => moveWarning(side, b, maxBps, threshold));
/** Short chip tag: "+38%" / "−38%"; over the limit adds "!" (chips are 82 px). */
export const chipTag = (side: "buy" | "sell", w: MoveWarn | null | undefined) => (!w || w.level === "none" || w.pct == null ? "" : `${side === "buy" ? "+" : "−"}${w.pct}%${w.level === "over" ? "!" : ""}`);

/** Round UP to the cent (never shows $0.00 for a buy that is still needed). Float noise below 1e-9 cents is ignored. */
export const ceilCents = (usd: number) => (usd > 0 ? Math.ceil(usd * 100 - 1e-7) / 100 : 0);

/** The engine drops live buys under its MIN_SHOT ($0.20, public/flight/engine.js "MINIMUM BUY"), so GRADUATE never asks for less. */
export const GRAD_MIN_USD = 0.2;
/**
 * $ for the GRADUATE button from SITE's GradNeed.usdgIn (USDG raw, quoted through the router; SITE already adds +0.1%).
 * No extra margin (SITE's withGradMargin is classifier tolerance only). Rounded UP to the cent, floored at GRAD_MIN_USD. null / 0 / unroutable ⇒ null (hide GRADUATE).
 * (IRON on testnet 2026-10-24: usdgIn ≈ 0.2846 USDG ⇒ $0.29.)
 */
export function graduateUsdFromUsdg(usdgRaw: bigint | null | undefined, usdgDecimals = 6, minUsd = GRAD_MIN_USD): number | null {
  if (usdgRaw == null || usdgRaw <= BigInt(0)) return null;
  const usd = Number(usdgRaw) / 10 ** usdgDecimals;
  if (!(usd > 0) || !Number.isFinite(usd)) return null;
  return Math.max(minUsd, ceilCents(usd));
}

/** Show GRADUATE when the exact graduating buy is at or below the smallest preset (the "≈$0 buys needed" state). */
export function showGraduate(gradUsd: number | null | undefined, presets: readonly number[]): boolean {
  if (typeof gradUsd !== "number" || !(gradUsd > 0)) return false;
  const ps = presets.filter((v) => v > 0);
  return ps.length === 0 || gradUsd <= Math.min(...ps);
}
/** PLACEHOLDER label: "GRADUATE · $0.29" (always cents, so it never reads $0). */
export const graduateLabel = (usd: number) => `GRADUATE · $${ceilCents(usd).toFixed(2)}`;

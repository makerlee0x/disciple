/**
 * GAME graduation fix (maker lee 2026-10-24 7:04 PM CT, "graduation fix 1-3", item 3 = GAME). Pure helpers, no viem / DOM,
 * shared by components/TradeBridge.tsx, components/flight/PhoneTradeBar.tsx and scripts/test-grad-fix.mjs:
 *   1. price-move WARNINGS before a big trade (chip, picker sheet, trade bar): "Big move: price +38%" at ≥ BIG_MOVE_BPS, and
 *      "Too big for this rocket right now" when the quote is over the router's live max impact (lib/flight/gradShim
 *      getMaxImpactBps; NEVER hard-coded; 0 = no cap). Scope change from lee 7:09 PM CT: NOTHING is greyed, disabled or
 *      blocked for price impact, in any mode, and the warning is never a confirm dialog (rapid taps still send).
 *   2. one exact GRADUATE buy, sized from the curve (gradShim getGraduationBuy), never from the HUD's ≈ maths.
 *   3. plain trade error copy (no "router" / "slippage" / "minOut" / "gas").
 * ALL player copy below is PLACEHOLDER pending lee + BRAND.
 */

/** Stable trade-error codes. Mirrors the codes SITE's grad/gas PR will export (TODO(SITE): import theirs once landed). */
export type TradeErrorCode = "PRICE_IMPACT" | "MIN_OUT" | "OUT_OF_GAS" | "OTHER";

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

/** Curve quoteBuy result fields the graduation maths needs. */
export type GradQuote = { tokensOut: bigint; graduates: boolean; refund: bigint };
/**
 * Exact graduating buy from ONE oversized curve quote: the curve fills up to graduation and refunds the rest, so
 * inputNeeded = probeIn − refund (fee included) and remainingTokens = tokensOut. Not graduating ⇒ null (not close / unknown).
 * (Checked on testnet IRON 2026-10-24: progress 9999 bps ⇒ 114.2 STRATEGY ≈ $0.28 left, 8.31 tokens.)
 */
export function graduationFromProbe(probeIn: bigint, q: GradQuote): { remainingTokens: bigint; inputNeeded: bigint } | null {
  if (!q || !q.graduates || probeIn <= BigInt(0)) return null;
  const inputNeeded = probeIn - (q.refund > BigInt(0) ? q.refund : BigInt(0));
  return inputNeeded > BigInt(0) ? { remainingTokens: q.tokensOut, inputNeeded } : null;
}

/** Default safety margin on the GRADUATE $: 3% (+1¢). The curve refunds any excess, so overshooting is safe; undershooting is not. */
export const GRAD_MARGIN_BPS = 300;
/**
 * $ to spend for the GRADUATE button. inputNeeded is in the coin's quote token: USDG-quoted ⇒ 1:1 dollars at usdgDecimals;
 * otherwise × the curve's launch-fixed quotePriceUsd (USD WAD per 1e18 quote raw, as lib/protocol-viem usdToAmountIn).
 * Rounded UP to the cent, never below the engine's minimum buy.
 */
export function graduateUsd(o: { inputNeeded: bigint; quoteIsUsdg: boolean; usdgDecimals: number; quotePriceUsd: bigint; marginBps?: number; minShot?: number }): number {
  if (!(o.inputNeeded > BigInt(0))) return 0;
  const raw = o.quoteIsUsdg ? Number(o.inputNeeded) / 10 ** o.usdgDecimals
    : Number((o.inputNeeded * o.quotePriceUsd) / BigInt(1e18)) / 1e18;
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const m = (o.marginBps ?? GRAD_MARGIN_BPS) / 10_000;
  return Math.max(o.minShot ?? 0, ceilCents(raw * (1 + m) + 0.01));
}

/** Show GRADUATE when the exact graduating buy is at or below the smallest preset (the "≈$0 buys needed" state). */
export function showGraduate(gradUsd: number | null | undefined, presets: readonly number[]): boolean {
  if (typeof gradUsd !== "number" || !(gradUsd > 0)) return false;
  const ps = presets.filter((v) => v > 0);
  return ps.length === 0 || gradUsd <= Math.min(...ps);
}
/** PLACEHOLDER label: "GRADUATE · $0.29" (always cents, so it never reads $0). */
export const graduateLabel = (usd: number) => `GRADUATE · $${ceilCents(usd).toFixed(2)}`;

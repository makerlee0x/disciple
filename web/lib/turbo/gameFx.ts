/**
 * TURBO game-side helpers (GAME). Pure, no DOM: unit-tested by scripts/test-turbo-ui.mjs.
 * Position money math (fees, PnL after fees, wipeout incl. fees, partial close, funding) is SITE's lib/turbo/math.ts and
 * the adapter's numbers; this file only holds what the screens need on top: TP/SL validation + which line a price hits,
 * danger distance / heat / beep thresholds, the leverage → jetstream curve and the big-win rule.
 */
/** Is the price at or past the wipeout price? */
export function isLiquidated(side: "long" | "short", price: number, liq: number) {
  return side === "long" ? price <= liq : price >= liq;
}

/** TP/SL: which trigger (if any) the price hits. Wipeout wins over both; SL wins over TP on the same tick. */
export function trigger(side: "long" | "short", price: number, o: { liqPrice: number; tpPrice?: number; slPrice?: number }): "liq" | "sl" | "tp" | null {
  if (o.liqPrice > 0 && isLiquidated(side, price, o.liqPrice)) return "liq";
  const up = side === "long";
  if (o.slPrice && o.slPrice > 0 && (up ? price <= o.slPrice : price >= o.slPrice)) return "sl";
  if (o.tpPrice && o.tpPrice > 0 && (up ? price >= o.tpPrice : price <= o.tpPrice)) return "tp";
  return null;
}

/** A TP/SL is valid only on the right side of the current price and inside the wipeout. "" = ok. */
export function tpSlProblem(side: "long" | "short", price: number, liq: number, tp?: number, sl?: number): "" | "tp-side" | "sl-side" | "sl-past-wipeout" {
  const up = side === "long";
  if (tp != null && tp > 0 && (up ? tp <= price : tp >= price)) return "tp-side";
  if (sl != null && sl > 0) {
    if (up ? sl >= price : sl <= price) return "sl-side";
    if (up ? sl <= liq : sl >= liq) return "sl-past-wipeout";
  }
  return "";
}

/** 1 at entry, 0 at the wipeout price (clamped 0..1). */
export function wipeoutDistance(entry: number, liq: number, price: number) {
  const span = Math.abs(entry - liq);
  if (!(span > 0)) return 1;
  const d = (liq < entry ? price - liq : liq - price) / span;
  return Math.max(0, Math.min(1, d));
}
/** % price move left before the wipeout (positive), for "0.05% away". */
export function wipeoutPctAway(side: "long" | "short", price: number, liq: number) {
  if (!(price > 0) || !(liq > 0)) return 0;
  return Math.max(0, (side === "long" ? (price - liq) : (liq - price)) / price * 100);
}

/** Danger beeps at 20%, 10% and 5% of the entry→wipeout distance left. */
export const BEEP_LEVELS = [0.2, 0.1, 0.05] as const;
/** 0 = calm, 1 = ≤20% left, 2 = ≤10%, 3 = ≤5% */
export function beepLevel(distance: number) {
  let lv = 0; BEEP_LEVELS.forEach((t, i) => { if (distance <= t) lv = i + 1; }); return lv;
}
/**
 * Beep only when crossing INTO a deeper level. Levels re-arm once the price backs off past the threshold plus
 * a small hysteresis (so a price sitting on a line does not machine-gun beeps).
 */
export function nextBeep(prevArmed: number, distance: number, hyst = 0.02): { beep: number; armed: number } {
  const lv = beepLevel(distance);
  if (lv > prevArmed) return { beep: lv, armed: lv };
  // back off: drop the armed level once we are clearly above that level's threshold
  let armed = prevArmed;
  while (armed > 0 && distance > BEEP_LEVELS[armed - 1] + hyst) armed--;
  return { beep: 0, armed };
}

/** Heat 0..1 from the distance left (1 = at the wipeout). Danger states: >0.5 hot, >0.8 shudder, >0.95 about to blow. */
export function heatOf(distance: number) { return Math.max(0, Math.min(1, 1 - distance)); }

/** Jetstream intensity from leverage: log10(lev)/3 → 10× ≈ .33, 100× ≈ .67, 1000× = 1. */
export function jetOf(leverage: number) { return Math.max(0, Math.min(1, Math.log10(Math.max(1, leverage)) / 3)); }

/** Big win share card: PnL after fees ≥ 50% of the bet (and at least $5). */
export function isBigWin(pnlUsd: number, betUsd: number) { return pnlUsd >= 5 && betUsd > 0 && pnlUsd / betUsd >= 0.5; }

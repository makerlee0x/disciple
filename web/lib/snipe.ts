/**
 * Shared sniper-tax (anti-snipe) countdown helper: GAME HUD chip + BOOST panel.
 * Import-light on purpose (only ./config) so node test loaders can transpile it standalone.
 *
 * On-chain model (AntiSnipe.currentFeeBps): fee = START − START·elapsed/DURATION, linear, 0 once elapsed ≥ DURATION,
 * elapsed counted from AntiSnipe.launchTimestamp[token] (= the launch block's timestamp, = BondingCurve.launchTime).
 *   new steep curve (feat/steep-curve-floor Constants.sol): ANTI_SNIPE_START_BPS 9900 (99%), ANTI_SNIPE_DURATION 77 s
 *   OLD v4 testnet (origin/main Constants.sol:88-90):       ANTI_SNIPE_START_BPS 7770 (77.7%), ANTI_SNIPE_DURATION 7 s
 * The live curve read (CurveState.snipeFeeBps ← BondingCurve.currentSnipeFeeBps) is authoritative whenever present.
 */
import { CURVE } from "./config";

/** Old v4 testnet schedule (origin/main contracts/src/libraries/Constants.sol ANTI_SNIPE_START_BPS / ANTI_SNIPE_DURATION). */
export const LEGACY_SNIPE = { startPct: 77.7, windowSec: 7 } as const;
/** New steep-curve schedule (lib/config CURVE, mirrors Constants.sol on feat/steep-curve-floor). */
export const STEEP_SNIPE = { startPct: CURVE.antiSnipeStartPct, windowSec: CURVE.antiSnipeWindowSec } as const;

/** Chip label (lee's wording: "ANTI-SNIPE 0:48 · 62%"). */
export const SNIPE_CHIP_LABEL = "ANTI-SNIPE";

export type SnipeInput = {
  /** Launch timestamp, unix SECONDS (AntiSnipe.launchTimestamp / BondingCurve.launchTime). */
  launchTs: number;
  /** Current time, unix SECONDS (prefer chain time when known). */
  nowSec: number;
  startPct: number;
  windowSec: number;
  /** Live CurveState.snipeFeeBps; when a finite number it wins for feePct. */
  liveFeeBps?: number | null;
};
export type SnipeState = {
  active: boolean;
  /** ceil(remaining window seconds), ≥ 0 (0 whenever !active). */
  secondsLeft: number;
  /** Fee %, rounded to one decimal. */
  feePct: number;
  /** Unrounded fee %. */
  feePctRaw: number;
};

const OFF: SnipeState = { active: false, secondsLeft: 0, feePct: 0, feePctRaw: 0 };
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function snipeState({ launchTs, nowSec, startPct, windowSec, liveFeeBps }: SnipeInput): SnipeState {
  if (!fin(launchTs) || !fin(nowSec) || !fin(startPct) || !fin(windowSec) || launchTs <= 0 || windowSec <= 0 || startPct <= 0)
    return OFF;
  const elapsed = Math.max(0, nowSec - launchTs); // clock skew before launch → treat as t = 0
  const remaining = Math.max(0, windowSec - elapsed);
  const secondsLeft = Math.max(0, Math.ceil(remaining));
  let raw = Math.min(startPct, Math.max(0, startPct * (remaining / windowSec)));
  const live = fin(liveFeeBps);
  if (live) raw = Math.max(0, liveFeeBps) / 100;
  const active = elapsed < windowSec && secondsLeft > 0 && !(live && liveFeeBps <= 0);
  if (!active) return OFF; // HUD hides the chip: no countdown, no fee
  return { active, secondsLeft, feePct: Math.round(raw * 10) / 10, feePctRaw: raw };
}

/** Coin shape the discriminator reads: BondingCurve.curveParams()/curveTail() (lib/protocol-viem curveParams → CurveParams)
 *  or Launchpad.LaunchTierContext.totalSupply (lib/events). Raw wei bigint, or a number (whole tokens, or wei if ≥ 1e18). */
export type SnipeCoin = { totalSupply?: bigint | number | null; tail?: bigint | number | null } | null | undefined;

/** Whole-token supply above this ⇒ pre-steep 7B coin (steep curve = 1M). */
const LEGACY_SUPPLY_MIN_TOKENS = 10_000_000;

/**
 * Anti-snipe schedule for a coin.
 * Discriminator (old v4 testnet coin vs steep-curve coin), same signals #129 already uses:
 *  1. totalSupply: main Constants.TOTAL_SUPPLY = 7B; steep curve = 1M (feat/steep-curve-floor Constants.sol:10).
 *     Available as CurveParams.totalSupply (curveParams()) and LaunchTierContext.totalSupply.
 *  2. else tail: pre-steep curves have no curveTail() → lib/protocol-viem curveParams() catches to 0n; steep curves have tail > 0.
 *  Unknown → the new schedule (every launch after the redeploy).
 */
export function snipeParamsFor(coin: SnipeCoin): { startPct: number; windowSec: number } {
  const ts = coin?.totalSupply;
  if (ts != null) {
    const tokens = typeof ts === "bigint" ? Number(ts / BigInt(1e18)) : ts >= 1e18 ? ts / 1e18 : ts;
    if (Number.isFinite(tokens) && tokens > 0) return tokens > LEGACY_SUPPLY_MIN_TOKENS ? { ...LEGACY_SNIPE } : { ...STEEP_SNIPE };
  }
  const tail = coin?.tail;
  if (tail != null && (typeof tail === "bigint" || Number.isFinite(tail))) {
    return BigInt(typeof tail === "bigint" ? tail : Math.trunc(tail)) > BigInt(0) ? { ...STEEP_SNIPE } : { ...LEGACY_SNIPE };
  }
  return { ...STEEP_SNIPE };
}

/** "m:ss" countdown (77 → "1:17"); fractions ceil, negative/NaN → "0:00". */
export function formatSnipeClock(secondsLeft: number): string {
  const s = fin(secondsLeft) && secondsLeft > 0 ? Math.ceil(secondsLeft) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "ANTI-SNIPE 0:48 · 62%" (fee as an integer %). */
export function formatSnipeChip(state: Pick<SnipeState, "secondsLeft" | "feePct"> & { feePctRaw?: number }): string {
  const pct = Math.round(fin(state.feePctRaw) ? state.feePctRaw : fin(state.feePct) ? state.feePct : 0);
  return `${SNIPE_CHIP_LABEL} ${formatSnipeClock(state.secondsLeft)} · ${pct}%`;
}

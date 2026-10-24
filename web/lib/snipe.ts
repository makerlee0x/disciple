/**
 * STUB — minimal local stand-in for SITE's web/lib/snipe.ts (replace with SITE's; this commit can be dropped).
 * Same exported signature SITE announced:
 *   snipeState({ launchTs, nowSec, startPct, windowSec, liveFeeBps? }) => { active, secondsLeft (integer), feePct }
 *   snipeParamsFor(coin) => { startPct, windowSec }
 *   formatSnipeClock(secondsLeft) => "m:ss"
 * Pure (no DOM / React / chain imports) so offline tests can load it.
 */
import { ANTI_SNIPE_SCHEDULES, type CurveGeneration } from "./config";

export type SnipeParams = { startPct: number; windowSec: number };
export type SnipeInput = SnipeParams & { launchTs: number; nowSec: number; /** live BondingCurve.currentSnipeFeeBps(); wins for the % when present */ liveFeeBps?: number | null };
export type SnipeState = { active: boolean; secondsLeft: number; feePct: number };
/** a coin as far as the schedule cares: an explicit generation, or the curve's curveTail() (steep curves only; absent/0 ⇒ v4) */
export type SnipeCoin = { generation?: CurveGeneration; curveTail?: bigint | number | null } | null | undefined;

const OFF: SnipeState = { active: false, secondsLeft: 0, feePct: 0 };

/** Linear startPct → 0 over windowSec from launchTs, clamped both ends (before launch = full fee, full window). */
export function snipeState({ launchTs, nowSec, startPct, windowSec, liveFeeBps }: SnipeInput): SnipeState {
  if (!(windowSec > 0) || !(startPct > 0) || !Number.isFinite(launchTs) || !Number.isFinite(nowSec)) return OFF;
  const elapsed = Math.min(windowSec, Math.max(0, nowSec - launchTs));
  const secondsLeft = Math.max(0, Math.ceil(windowSec - elapsed));
  let feePct = Math.max(0, Math.min(startPct, startPct * (1 - elapsed / windowSec)));
  if (liveFeeBps != null && Number.isFinite(liveFeeBps)) feePct = Math.max(0, liveFeeBps) / 100;
  if (secondsLeft <= 0 || feePct <= 0) return OFF;
  return { active: true, secondsLeft, feePct };
}

/** Schedule for a coin from lib/config ANTI_SNIPE_SCHEDULES (never hardcoded). Unknown coin ⇒ the current (steep) schedule. */
export function snipeParamsFor(coin: SnipeCoin): SnipeParams {
  let gen: CurveGeneration = "steep";
  if (coin?.generation) gen = coin.generation;
  else if (coin && "curveTail" in coin && coin.curveTail != null) gen = BigInt(coin.curveTail) > BigInt(0) ? "steep" : "v4";
  const s = ANTI_SNIPE_SCHEDULES[gen];
  return { startPct: s.startPct, windowSec: s.windowSec };
}

/** 77 → "1:17", 48 → "0:48", 5 → "0:05" */
export function formatSnipeClock(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(secondsLeft) ? secondsLeft : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

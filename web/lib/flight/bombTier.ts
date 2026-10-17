/**
 * Bomb tier = price impact only, the SAME rule as public/flight/engine.js (estimateImpactPct + bombTierOf) on the
 * shared constitution thresholds lib/config BOMB_PCT / BOMB_TIERS (PUFF <2 · GRENADE 2 · BUNKER 5 · CRUISE 12 ·
 * NUKE 25 · ATOM ≥50 %). test:gamechat checks engine.js against this file so chat rows and in-game blasts agree.
 */
import { BOMB_TIERS } from "../config";

export type ImpactInput = { impactPct?: number; prePrice?: number; postPrice?: number; impactBps?: number };

/** |Δprice| % for a trade, engine precedence: impactPct → pre/post price → impactBps (chain Trade event). null = no impact data. */
export function impactPctOf(t: ImpactInput | null | undefined): number | null {
  if (!t) return null;
  if (Number.isFinite(t.impactPct)) return Math.abs(t.impactPct as number);
  if ((t.prePrice as number) > 0 && (t.postPrice as number) > 0) return Math.abs((t.postPrice as number) / (t.prePrice as number) - 1) * 100;
  if (Number.isFinite(t.impactBps)) return Math.abs(t.impactBps as number) / 100;
  return null;
}

/** engine bombTierOf: index into BOMB_TIERS (0 puff … 5 atom) of the highest tier whose min ≤ pct. */
export function bombTierIndex(pct: number): number {
  let i = 0; for (let k = 0; k < BOMB_TIERS.length; k++) if (pct >= BOMB_TIERS[k].min) i = k; return i;
}

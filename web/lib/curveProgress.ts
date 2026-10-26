/** Coin-card curve progress (Launchpad cards/rows). Kept out of lib/config so config stays import-free for the test loaders. */
import { CURVE } from "./config";
import { curveFracAtMcap } from "./curveMath";

/**
 * Coin-card curve progress, 0–100, by TOKENS SOLD (fraction of the curve's supply; 84.24% of supply = 100 = graduation).
 * Live coins pass the contract's progressBps (tokensSold·1e4/sCurve); otherwise the sold fraction is read back from the
 * dollar mcap through the steep curve (lib/curveMath), which is the same number for a $1-quote curve.
 */
export function curveProgress(c: { mcap: number | null; graduated?: boolean; progressBps?: number | null }): number | null {
  if (c.graduated) return 100;
  // progressBps 0 with a moved mcap = the read failed (listLaunches catches to 0) → fall back to the mcap read-back.
  const failed = c.progressBps === 0 && c.mcap != null && c.mcap > CURVE.startMcap * 1.05;
  if (c.progressBps != null && Number.isFinite(c.progressBps) && !failed) return Math.max(0, Math.min(100, c.progressBps / 100));
  if (c.mcap == null) return null;
  if (c.mcap >= CURVE.graduationMcap) return 100;
  return Math.max(0, Math.min(100, curveFracAtMcap(c.mcap) * 100));
}

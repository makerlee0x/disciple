/**
 * Paper-mode market for the flight engine (no wallet): the parameters engine.js prices paper buys/sells with.
 *
 * Handed to the engine as window.__PAPER_CURVE (plain numbers, so the worker render path can structured-clone it).
 * Derived from lib/config CURVE + lib/curveMath TRADE_FEE_BPS through the SIMULATOR's own Market (lib/sim/market.ts,
 * LAUNCH in lib/sim/config.ts), so paper, sim and the Launchpad curve (CurveMath.sol) share one parameter set:
 *   before graduation — the bonding curve: x = x0·y0 / (y0 − sold), y = y0 − sold, spot = x / y (exact fills,
 *     a buy never gets more than sCurve − sold tokens; a buy that completes the curve is refunded the rest);
 *   after graduation  — the v4-style full-range pool seeded at the curve-end price (Migration.sol), constant
 *     liquidity L = (S − sCurve)·√p_grad, exactly the sim's Pool(p·Y, Y) without range orders.
 * engine.js runs the same float formulas; `npm run test:audit` checks its fills against Market/Pool and against
 * curveMath.quoteBuy/quoteSell (the bigint mirror of CurveMath.sol).
 */
import { CURVE } from "../config";
import { LAUNCH, SIM_CONFIG } from "../sim/config";
import { Market } from "../sim/market";

export interface PaperCurve {
  /** total supply, tokens sold on the curve at graduation */
  S: number; sC: number;
  /** curve virtual reserves at sold = 0 (quote, tokens) */
  x0: number; y0: number;
  /** 1% protocol fee on the curve (buy: before the curve; sell: from the output) and in the pool (hook fee) */
  fee: number; poolFee: number;
  startMcap: number; gradMcap: number; quoteUsd: number;
  /** post-graduation full-range pool liquidity (√(X·Y) at the curve-end price) */
  L: number;
}

export function paperCurve(): PaperCurve {
  const m = new Market(SIM_CONFIG);
  const yEnd = m.y0 - m.sC, pGrad = (m.x0 * m.y0 / yEnd) / yEnd, Y = m.S - m.sC;
  return {
    S: m.S, sC: m.sC, x0: m.x0, y0: m.y0, fee: m.fee, poolFee: m.poolFee,
    startMcap: CURVE.startMcap, gradMcap: CURVE.graduationMcap, quoteUsd: LAUNCH.quotePriceUsd,
    L: Y * Math.sqrt(pGrad),
  };
}

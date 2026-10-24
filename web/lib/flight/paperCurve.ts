/**
 * Paper-mode market for the flight engine (no wallet): the parameters engine.js prices paper buys/sells with.
 *
 * Handed to the engine as window.__PAPER_CURVE (plain numbers, so the worker render path can structured-clone it).
 * Derived from lib/config CURVE + lib/curveMath TRADE_FEE_BPS through the SIMULATOR's own Market (lib/sim/market.ts,
 * LAUNCH in lib/sim/config.ts), so paper, sim and the Launchpad curve (CurveMath.sol) share one parameter set:
 *   before graduation — steep curve #1 in g = sold / sCurve: mcap m(g) = M0/(1 − a·g)² + T·g³⁰, reserve
 *     R(g) = f·M0·g/(1 − a·g) + f·T·g³¹/31 (exact fills, a buy never gets more than sCurve − sold tokens; a buy that
 *     completes the curve is refunded the rest);
 *   after graduation  — the v4-style full-range pool seeded at the curve-end price (Migration.sol), constant
 *     liquidity L = (S − sCurve)·√p_grad, exactly the sim's Pool(p·Y, Y) without range orders (and without the
 *     locked floor bands: paper sells after graduation are priced on the bare full-range pool).
 * engine.js runs the same float formulas; `npm run test:audit` checks its fills against Market/Pool and against
 * curveMath.quoteBuy/quoteSell (the bigint mirror of CurveMath.sol).
 */
import { CURVE } from "../config";
import { LAUNCH, SIM_CONFIG } from "../sim/config";
import { Market } from "../sim/market";

export interface PaperCurve {
  /** total supply, tokens sold on the curve at graduation */
  S: number; sC: number;
  /** CP-part virtual reserves at sold = 0 (quote, tokens) */
  x0: number; y0: number;
  /** steep curve #1 shape in quote units: m(g) = M0/(1 − a·g)² + T·g³⁰, f = sCurve / S */
  M0: number; a: number; T: number; f: number;
  /** 1% protocol fee on the curve (buy: before the curve; sell: from the output) and in the pool (hook fee) */
  fee: number; poolFee: number;
  startMcap: number; gradMcap: number; quoteUsd: number;
  /** post-graduation full-range pool liquidity (√(X·Y) at the curve-end price) */
  L: number;
}

export function paperCurve(): PaperCurve {
  const m = new Market(SIM_CONFIG);
  const pGrad = m.mcapAt(1) / m.S, Y = m.S - m.sC;
  return {
    S: m.S, sC: m.sC, x0: m.x0, y0: m.y0, M0: m.M0, a: m.a, T: m.T, f: m.f, fee: m.fee, poolFee: m.poolFee,
    startMcap: CURVE.startMcap, gradMcap: CURVE.graduationMcap, quoteUsd: LAUNCH.quotePriceUsd,
    L: Y * Math.sqrt(pGrad),
  };
}

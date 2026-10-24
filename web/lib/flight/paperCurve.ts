/**
 * Paper-mode market for the flight engine (no wallet): the parameters engine.js prices paper buys/sells with.
 *
 * Handed to the engine as window.__PAPER_CURVE (plain numbers, so the worker render path can structured-clone it).
 * Derived from lib/curveMath (the bigint mirror of CurveMath.sol, launch params at a $1 quote) + lib/config CURVE, so
 * paper and the Launchpad curve share one parameter set (steep curve #1):
 *   before graduation — m(g) = M0/(1−a·g)² + T·g^30, g = sold / sCurve: the constant-product part x = x0·y0 / (y0 − sold),
 *     y = y0 − sold (spot = x / y) plus the steep tail `tail`·g^30 ($ mcap at g = 1). A buy never gets more than
 *     sCurve − sold tokens; a buy that completes the curve is refunded the rest.
 *   after graduation  — the v4-style full-range pool seeded at the curve-end price (Migration.sol), constant
 *     liquidity L = (S − sCurve)·√p_grad.
 * `npm run test:audit` checks engine fills against curveMath.quoteBuy/quoteSell. engine.js paperFill prices the full curve,
 * CP part plus the `tail`·g^30 steep tail (GAME #128).
 */
import { CURVE } from "../config";
import { TRADE_FEE_BPS, paramsFromQuotePrice, WAD } from "../curveMath";

export interface PaperCurve {
  /** total supply, tokens sold on the curve at graduation */
  S: number; sC: number;
  /** curve virtual reserves at sold = 0 (quote $, tokens): the constant-product part of m(g) */
  x0: number; y0: number;
  /** steep tail: extra mcap ($) at g = 1, added as tail·g^30 (CurveMath.sol curveTail) */
  tail: number;
  /** 1% protocol fee on the curve (buy: before the curve; sell: from the output) and in the pool (hook fee) */
  fee: number; poolFee: number;
  startMcap: number; gradMcap: number; quoteUsd: number;
  /** post-graduation full-range pool liquidity (√(X·Y) at the curve-end price) */
  L: number;
}

export function paperCurve(): PaperCurve {
  const p = paramsFromQuotePrice(WAD), n = (b: bigint) => Number(b) / 1e18;
  const S = n(p.totalSupply), sC = n(p.sCurve), fee = Number(TRADE_FEE_BPS) / 10_000;
  const pGrad = CURVE.graduationMcap / S, Y = S - sC;
  return {
    S, sC, x0: n(p.x0), y0: n(p.y0), tail: n(p.tail), fee, poolFee: fee,
    startMcap: CURVE.startMcap, gradMcap: CURVE.graduationMcap, quoteUsd: 1,
    L: Y * Math.sqrt(pGrad),
  };
}

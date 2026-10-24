/**
 * Off-chain mirror of contracts/src/libraries/CurveMath.sol + FeeMath (quotes only;
 * the contract is authoritative). No bigint literals (tsconfig has no ES2020 target).
 */
const B = BigInt;
export const WAD = B("1000000000000000000");
const BPS = B(10000);
export const TRADE_FEE_BPS = B(100); // 1% protocol fee (taken before curve, on buy; from output on sell)

export interface CurveParams {
  totalSupply: bigint;
  sCurve: bigint;
  x0: bigint;
  y0: bigint;
  /** steep tail mcap at g=1 in quote wei (BondingCurve.curveTail()); m(g) = CP(x0,y0) + tail·g^30 */
  tail: bigint;
}

const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint) => { const n = a * b; return n / d + (n % d === B(0) ? B(0) : B(1)); };
const RAY = WAD * WAD;
const md = (a: bigint, b: bigint, d: bigint, up: boolean) => (up ? mulDivUp(a, b, d) : mulDiv(a, b, d));

/* ---- steep curve #1 (CurveMath.sol): m(g) = M0/(1−a·g)² + T·g^30, g = sold/sCurve; same rounding as Solidity ---- */
const gOf = (p: CurveParams, s: bigint, up: boolean) => md(s, RAY, p.sCurve, up);
function pow30(g: bigint, up: boolean) {
  if (g === B(0)) return g;
  const m = (a: bigint, b: bigint) => md(a, b, RAY, up);
  const g2 = m(g, g), g4 = m(g2, g2), g8 = m(g4, g4), g16 = m(g8, g8);
  return m(m(m(g16, g8), g4), g2);
}
const pow31 = (g: bigint, up: boolean) => (g === B(0) ? g : md(pow30(g, up), g, RAY, up));
const cpMcap = (p: CurveParams, s: bigint) => { const y = p.y0 - s; return mulDiv(mulDiv(p.x0, p.y0, y), p.totalSupply, y); };
const tailMcap = (p: CurveParams, s: bigint, up: boolean) => (s === B(0) ? s : md(p.tail, pow30(gOf(p, s, up), up), RAY, up));

/** Curve mcap in quote wei at `sold` (CurveMath.marketCapQuote). */
export const marketCapQuote = (p: CurveParams, sold: bigint) => cpMcap(p, sold) + tailMcap(p, sold, false);

/** Exact curve cost of [s1, s2] (CurveMath.costUp / costDown). */
export function curveCost(p: CurveParams, s1: bigint, s2: bigint, up: boolean) {
  if (s2 <= s1) return B(0);
  const cp = md(p.x0 * p.y0, s2 - s1, (p.y0 - s1) * (p.y0 - s2), up);
  const hi = pow31(gOf(p, s2, up), up), lo = pow31(gOf(p, s1, !up), !up);
  return cp + (hi > lo ? md(p.tail * p.sCurve, hi - lo, B(31) * p.totalSupply * RAY, up) : B(0));
}

function priceWadUp(p: CurveParams, s: bigint) {
  const y = p.y0 - s;
  return mulDivUp(mulDivUp(p.x0 * p.y0, p.totalSupply, y * y) + tailMcap(p, s, true), WAD, p.totalSupply);
}

/** Tokens out for net quote (CurveMath.tokensOutForQuoteCapped: Newton from above, never more than paid for). */
export function tokensOutForQuote(p: CurveParams, sold: bigint, quoteIn: bigint, cap?: bigint) {
  if (quoteIn <= B(0) || sold >= p.sCurve || cap === B(0)) return B(0);
  let rem = p.sCurve - sold;
  if (cap !== undefined && cap < rem) rem = cap;
  const y = p.y0 - sold;
  let dt = mulDiv(y, quoteIn, mulDiv(p.x0, p.y0, y) + quoteIn) + B(1);
  if (dt > rem) dt = rem;
  for (let i = 0; i < 64; i++) {
    const c = curveCost(p, sold, sold + dt, true);
    if (c <= quoteIn) return dt;
    let step = mulDiv(c - quoteIn, WAD, priceWadUp(p, sold + dt));
    if (step === B(0)) step = B(1);
    if (step >= dt) return B(0);
    dt -= step;
  }
  throw new Error("CurveMath: no convergence");
}

/** Gross quote for selling tokensIn (CurveMath.quoteOutForTokens, incl. the G-7 clamp). */
export function quoteOutForTokens(p: CurveParams, sold: bigint, tokensIn: bigint) {
  if (tokensIn <= B(0) || tokensIn > sold) return B(0);
  const sAfter = sold - tokensIn;
  const q = curveCost(p, sAfter, sold, false), qMax = curveCost(p, sAfter, sold + B(1), true) - B(1);
  return q > qMax ? qMax : q;
}

/** quote raw × 1e18 / token raw — floored; coarse at 6-dec quotes, don't derive $ or ratios from it (FLOW #115). */
export function spotPriceWad(p: CurveParams, sold: bigint) {
  return mulDiv(marketCapQuote(p, sold), WAD, p.totalSupply);
}

/** Tokens out for a gross quoteIn (after 1% + creator tax; anti-snipe NOT modelled → minOut covers it only via slippage). */
export function quoteBuy(p: CurveParams, sold: bigint, quoteIn: bigint, creatorTaxBps: bigint) {
  const net = quoteIn - mulDiv(quoteIn, TRADE_FEE_BPS, BPS) - mulDiv(quoteIn, creatorTaxBps, BPS);
  if (sold >= p.sCurve || net <= B(0)) return B(0);
  return tokensOutForQuote(p, sold, net);
}

/** Quote out (net of 1% + creator tax) for selling tokensIn. */
export function quoteSell(p: CurveParams, sold: bigint, tokensIn: bigint, creatorTaxBps: bigint) {
  const gross = quoteOutForTokens(p, sold, tokensIn);
  return gross - mulDiv(gross, TRADE_FEE_BPS, BPS) - mulDiv(gross, creatorTaxBps, BPS);
}

export function applySlippage(amount: bigint, slippageBps: number) {
  return mulDiv(amount, BPS - B(Math.round(slippageBps)), BPS);
}

/** Price impact % between two sold levels (spot-to-spot; price ∝ curve mcap). */
export function impactPctBetween(p: CurveParams, soldBefore: bigint, soldAfter: bigint) {
  // steep curve: spot ∝ curve mcap (constant-product + tail). Ratio of marketCapQuote (quote raw × supply, not floored),
  // NOT of spotPriceWad (floored to a single-digit integer when the quote has 6 decimals — FLOW #115).
  const a = Number(marketCapQuote(p, soldBefore)), b = Number(marketCapQuote(p, soldAfter));
  return a > 0 ? ((b - a) / a) * 100 : 0;
}

/* ---- Launch-time curve (sold = 0), mirrors CurveMath.makeParams / quoteInForTokens ---- */
// Constants.sol: TOTAL_SUPPLY 1M, CURVE_SOLD_BPS 84.24%, START $3,333, CURVE_MID $15,000, GRADUATION $33,333 (USD WAD).
export const TOTAL_SUPPLY_WEI = B("1000000") * WAD;
export const CURVE_SOLD_BPS = B(8424);
export const START_MCAP_USD = B(3333) * WAD;
export const CURVE_MID_MCAP_USD = B(15000) * WAD;
export const GRADUATION_MCAP_USD = B(33333) * WAD;

function isqrt(n: bigint): bigint {
  if (n < B(2)) return n;
  let x = n, y = (x + B(1)) / B(2);
  while (y < x) { x = y; y = (x + n / x) / B(2); }
  return x;
}

/** CurveMath.makeParams(quotePriceUsd): the params a curve launched right now would get. */
export function paramsFromQuotePrice(quotePriceUsd: bigint): CurveParams {
  if (quotePriceUsd <= B(0)) throw new Error("quotePriceUsd = 0");
  const sCurve = mulDiv(TOTAL_SUPPLY_WEI, CURVE_SOLD_BPS, BPS);
  const m0Q = mulDiv(START_MCAP_USD, WAD, quotePriceUsd);
  const mMidQ = mulDiv(CURVE_MID_MCAP_USD, WAD, quotePriceUsd);
  const m1Q = mulDiv(GRADUATION_MCAP_USD, WAD, quotePriceUsd);
  const sqrtRWad = isqrt(mulDiv(mMidQ, WAD, m0Q) * WAD);
  const y0 = mulDiv(sCurve, sqrtRWad, sqrtRWad - WAD);
  const x0 = mulDiv(m0Q, y0, TOTAL_SUPPLY_WEI);
  const p: CurveParams = { totalSupply: TOTAL_SUPPLY_WEI, sCurve, x0, y0, tail: B(0) };
  p.tail = m1Q - cpMcap(p, sCurve);
  return p;
}

/** FeeMath.creatorBuyMax(bps): token cap for the launch buy. */
export const creatorBuyMaxTokens = (capBps: number) => mulDiv(TOTAL_SUPPLY_WEI, B(Math.round(capBps)), BPS);

/** Net quote (after fees) the launch buy on a fresh curve gets for `quoteIn` gross: 1% protocol + creator tax, no anti-snipe. */
const launchNet = (quoteIn: bigint, creatorTaxBps: bigint) => quoteIn - mulDiv(quoteIn, TRADE_FEE_BPS, BPS) - mulDiv(quoteIn, creatorTaxBps, BPS);

/** Tokens out for the launch buy on a fresh curve (Launchpad.quoteCreatorBuy mirror). */
export function launchBuyTokensOut(p: CurveParams, quoteIn: bigint, creatorTaxBps: bigint) {
  const net = launchNet(quoteIn, creatorTaxBps);
  return net <= B(0) ? B(0) : tokensOutForQuote(p, B(0), net);
}

/** Largest gross quoteIn whose launch buy stays ≤ capTokens (so Launchpad won't revert CreatorBuyTooLarge). */
export function maxLaunchBuyQuoteIn(p: CurveParams, capTokens: bigint, creatorTaxBps: bigint) {
  if (capTokens <= B(0) || capTokens >= p.sCurve) return B(0);
  // Buying capTokens+1 must be unaffordable: net < cost(0, cap+1) (ceil), then step down on gross rounding.
  const netMax = curveCost(p, B(0), capTokens + B(1), true) - B(1);
  let gross = mulDiv(netMax, BPS, BPS - TRADE_FEE_BPS - creatorTaxBps) + B(2);
  while (gross > B(0) && launchBuyTokensOut(p, gross, creatorTaxBps) > capTokens) gross -= B(1);
  return gross;
}

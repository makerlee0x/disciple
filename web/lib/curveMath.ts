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
}

const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;

export function virtualQuote(p: CurveParams, sold: bigint) {
  return mulDiv(p.x0, p.y0, p.y0 - sold);
}
/** quote raw × 1e18 / token raw — floored; single-digit at 6-dec quotes, don't derive $ or ratios from it. */
export function spotPriceWad(p: CurveParams, sold: bigint) {
  const y = p.y0 - sold;
  return mulDiv(mulDiv(p.x0, p.y0, y), WAD, y);
}

/** Tokens out for a gross quoteIn (after 1% + creator tax; anti-snipe NOT modelled → minOut covers it only via slippage). */
export function quoteBuy(p: CurveParams, sold: bigint, quoteIn: bigint, creatorTaxBps: bigint) {
  const net = quoteIn - mulDiv(quoteIn, TRADE_FEE_BPS, BPS) - mulDiv(quoteIn, creatorTaxBps, BPS);
  if (sold >= p.sCurve || net <= B(0)) return B(0);
  const y = p.y0 - sold;
  const x = mulDiv(p.x0, p.y0, y);
  const out = mulDiv(y, net, x + net);
  const rem = p.sCurve - sold;
  return out > rem ? rem : out;
}

/** Quote out (net of 1% + creator tax) for selling tokensIn. */
export function quoteSell(p: CurveParams, sold: bigint, tokensIn: bigint, creatorTaxBps: bigint) {
  if (tokensIn > sold) return B(0);
  const y = p.y0 - sold;
  const x = mulDiv(p.x0, p.y0, y);
  const gross = mulDiv(x, tokensIn, y + tokensIn);
  return gross - mulDiv(gross, TRADE_FEE_BPS, BPS) - mulDiv(gross, creatorTaxBps, BPS);
}

export function applySlippage(amount: bigint, slippageBps: number) {
  return mulDiv(amount, BPS - B(Math.round(slippageBps)), BPS);
}

/** Price impact % between two sold levels (spot-to-spot). */
export function impactPctBetween(p: CurveParams, soldBefore: bigint, soldAfter: bigint) {
  // spot ∝ x0·y0 / y² ⇒ b/a = (yBefore / yAfter)². Exact ratio of token reserves, NOT of spotPriceWad (floored to a
  // single-digit integer when the quote has 6 decimals — FLOW #115).
  const ya = Number(p.y0 - soldBefore), yb = Number(p.y0 - soldAfter);
  return ya > 0 && yb > 0 ? ((ya / yb) ** 2 - 1) * 100 : 0;
}

/* ---- Launch-time curve (sold = 0), mirrors CurveMath.makeParams / quoteInForTokens ---- */
// Constants.sol: TOTAL_SUPPLY 7B, CURVE_SOLD_BPS 72%, START $7K, GRADUATION $33K (USD WAD).
export const TOTAL_SUPPLY_WEI = B("7000000000") * WAD;
const CURVE_SOLD_BPS = B(7200);
const START_MCAP_USD = B(7000) * WAD;
const GRADUATION_MCAP_USD = B(33000) * WAD;

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
  const m1Q = mulDiv(GRADUATION_MCAP_USD, WAD, quotePriceUsd);
  const sqrtRWad = isqrt(mulDiv(m1Q, WAD, m0Q) * WAD);
  const y0 = mulDiv(sCurve, sqrtRWad, sqrtRWad - WAD);
  const x0 = mulDiv(m0Q, y0, TOTAL_SUPPLY_WEI);
  return { totalSupply: TOTAL_SUPPLY_WEI, sCurve, x0, y0 };
}

/** FeeMath.creatorBuyMax(bps): token cap for the launch buy. */
export const creatorBuyMaxTokens = (capBps: number) => mulDiv(TOTAL_SUPPLY_WEI, B(Math.round(capBps)), BPS);

/** Net quote (after fees) the launch buy on a fresh curve gets for `quoteIn` gross: 1% protocol + creator tax, no anti-snipe. */
const launchNet = (quoteIn: bigint, creatorTaxBps: bigint) => quoteIn - mulDiv(quoteIn, TRADE_FEE_BPS, BPS) - mulDiv(quoteIn, creatorTaxBps, BPS);

/** Tokens out for the launch buy on a fresh curve (Launchpad.quoteCreatorBuy mirror). */
export function launchBuyTokensOut(p: CurveParams, quoteIn: bigint, creatorTaxBps: bigint) {
  const net = launchNet(quoteIn, creatorTaxBps);
  return net <= B(0) ? B(0) : mulDiv(p.y0, net, p.x0 + net);
}

/** Largest gross quoteIn whose launch buy stays ≤ capTokens (so Launchpad won't revert CreatorBuyTooLarge). */
export function maxLaunchBuyQuoteIn(p: CurveParams, capTokens: bigint, creatorTaxBps: bigint) {
  if (capTokens <= B(0) || capTokens >= p.y0) return B(0);
  // tokensOut = floor(y0·net / (x0+net)) ≤ cap  ⇔  net ≤ floor(x0·cap / (y0−cap)) (+ rounding slack, checked below)
  const netMax = mulDiv(p.x0, capTokens, p.y0 - capTokens);
  let gross = mulDiv(netMax, BPS, BPS - TRADE_FEE_BPS - creatorTaxBps) + B(2);
  while (gross > B(0) && launchBuyTokensOut(p, gross, creatorTaxBps) > capTokens) gross -= B(1);
  return gross;
}

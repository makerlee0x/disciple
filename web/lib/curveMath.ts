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
  const a = Number(spotPriceWad(p, soldBefore)), b = Number(spotPriceWad(p, soldAfter));
  return a > 0 ? ((b - a) / a) * 100 : 0;
}

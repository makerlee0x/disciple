/**
 * Exact live fill from a trade's receipt logs (pure, no viem: unit-testable from node, see scripts/test-live-fixes.mjs).
 *
 * Preferred source = DiscipleRouter `UsdgTrade(trader indexed, token indexed, isBuy, amountIn, amountOut, viaCurve)`
 * (trader = msg.sender = the smart account): buy amountIn = USDG spent, amountOut = tokens; sell amountIn = tokens,
 * amountOut = USDG received (net). A graduating buy's `UsdgRefund(trader, token, quoteRefund, usdgRefund)` is subtracted.
 * Fallback (native-quote path, no router) = the venue `Trade` event (BondingCurve: last field mcapAfterUsd; AscensionHook:
 * last field sqrtPriceAfter ⇒ different topic0): tokenAmt exact, $ from quoteAmt × the quote's USD price.
 * Fee ($) = Trade.fee (quote raw) converted at the same quote→$ rate.
 */
export interface LogLike { address: string; topics: readonly string[]; data: string }
export interface DecodedFill {
  side: "buy" | "sell";
  /** USDG spent (buy, net of refund) / received (sell) in $ */
  usd: number;
  /** tokens received (buy) / sold (sell) */
  tokens: number;
  /** trade fee in $ (0 when unknown) */
  feeUsd: number;
  /** graduating buy: the overshoot the router sent back (UsdgRefund.usdgRefund) in $; absent when none */
  refundUsd?: number;
  source: "usdg" | "curve" | "hook";
}

export const TOPIC = {
  usdgTrade: "0x665badfa4a162a594433359d5d6665873407e34cab452ef6c8504bf190477b1a",
  usdgRefund: "0x4b56fe5da5cdebaaf396f5c8665f846a46f9ad9d40b767d881bb1b89f98f7cc5",
  /** BondingCurve.Trade(…, uint256 mcapAfterUsd) */
  curveTrade: "0xc9d4f93ded9b42fa24561e02b2a40f720f71601eb1b3f7b3fd4eff20877639ee",
  /** AscensionHook.Trade(…, uint160 sqrtPriceAfter) */
  hookTrade: "0x429d1e9e19c899db3fe448c2651841c2beb6846fdff9c61e31123b4262c94ef2",
} as const;

const lc = (s: string) => String(s || "").toLowerCase();
const topicAddr = (t: string | undefined) => (t ? "0x" + lc(t).slice(-40) : "");
const words = (data: string): bigint[] => {
  const h = lc(data).replace(/^0x/, ""), out: bigint[] = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64)));
  return out;
};
/** raw (decimals) → number without losing precision on big values */
export const units = (raw: bigint, decimals = 18) => {
  const d = BigInt(10) ** BigInt(decimals), w = raw / d, f = raw % d;
  return Number(w) + Number(f) / Number(d);
};

/**
 * Quote raw per token raw from a v4 sqrtPriceX96. Both currency orders are computed; the one whose ×1e18 value floors
 * to the event's priceAfterX18 (or is nearest to it) wins. 0 when sqrtP is 0.
 */
export function quotePerTokFromSqrt(sqrtP: bigint, priceAfterX18: bigint): number {
  if (sqrtP <= BigInt(0)) return 0;
  const s = Number(sqrtP) / 2 ** 96;
  const c0 = s * s, c1 = 1 / (s * s);                         // token = currency0: price = s²; token = currency1: 1/s²
  const target = Number(priceAfterX18);
  const err = (p: number) => Math.abs(Math.floor(p * 1e18) - target) / Math.max(1, target);
  return err(c0) <= err(c1) ? c0 : c1;
}

export interface DecodeOpts {
  token: string;
  /** the trading account (smart account / EOA) — the `trader` the events credit */
  trader?: string | null;
  /** DiscipleRouter address (only its UsdgTrade/UsdgRefund logs are trusted) */
  router?: string | null;
  /** USDG decimals (config: lib/usdg usdgDecimals()); required — no 18 default (6-dec USDG). */
  usdgDecimals: number;
  /** $ per token at the mark, for a hook-only fill (no mcapAfterUsd in the event) */
  markPriceUsd?: number;
  /** total supply (whole tokens) for curve mcap → price */
  supply?: number;
}

export function decodeTradeFill(logs: readonly LogLike[], o: DecodeOpts): DecodedFill | null {
  const token = lc(o.token), me = o.trader ? lc(o.trader) : "", router = o.router ? lc(o.router) : "";
  const dec = o.usdgDecimals, supply = o.supply || 1_000_000;
  const fromRouter = (l: LogLike) => !router || lc(l.address) === router;
  const mine = (a: string) => !me || a === me;
  // venue Trade for this token (prefer the trader's own row): token amount, fee, price
  let venue: { isBuy: boolean; quoteAmt: bigint; tokenAmt: bigint; fee: bigint; priceAfter: bigint; last: bigint; hook: boolean } | null = null;
  for (const l of logs) {
    const t0 = lc(l.topics[0]);
    if ((t0 !== TOPIC.curveTrade && t0 !== TOPIC.hookTrade) || topicAddr(l.topics[1]) !== token) continue;
    const w = words(l.data); if (w.length < 9) continue;
    const v = { isBuy: w[0] !== BigInt(0), quoteAmt: w[1], tokenAmt: w[2], fee: w[3], priceAfter: w[6], last: w[8], hook: t0 === TOPIC.hookTrade };
    if (!venue || mine(topicAddr(l.topics[2]))) venue = v;
    if (mine(topicAddr(l.topics[2]))) break;
  }
  // quote raw → $ rate from the venue event (only for the native-quote fallback; router fills use UsdgTrade below).
  // priceAfterX18 = quote raw × 1e18 / token raw, FLOORED on-chain: a single-digit integer at 6-dec USDG (FLOW #115).
  //  - hook: quote per token from sqrtPriceAfter (full precision); the currency order is the one consistent with the
  //    floored priceAfterX18 (no quote address needed).
  //  - curve: priceAfterX18 only when it has ≥ 6 significant digits; otherwise no native-quote $ (null fill).
  const quoteUsdPerRaw = (() => {
    if (!venue) return 0;
    const pxTok = venue.hook ? (o.markPriceUsd || 0) : units(venue.last) / supply;          // $ per whole token
    const quotePerTok = venue.hook ? quotePerTokFromSqrt(venue.last, venue.priceAfter)       // quote raw per token raw
      : Number(venue.priceAfter) >= 1e6 ? Number(venue.priceAfter) / 1e18 : 0;
    return pxTok > 0 && quotePerTok > 0 ? pxTok / quotePerTok / 1e18 : 0;                    // $ per quote raw unit
  })();

  for (const l of logs) {
    if (lc(l.topics[0]) !== TOPIC.usdgTrade || !fromRouter(l)) continue;
    if (topicAddr(l.topics[2]) !== token || !mine(topicAddr(l.topics[1]))) continue;
    const w = words(l.data); if (w.length < 3) continue;
    const isBuy = w[0] !== BigInt(0);
    let usdRaw = isBuy ? w[1] : w[2], refundRaw = BigInt(0);
    const tokRaw = isBuy ? w[2] : w[1];
    if (isBuy) for (const r of logs) {
      if (lc(r.topics[0]) !== TOPIC.usdgRefund || !fromRouter(r) || topicAddr(r.topics[2]) !== token || !mine(topicAddr(r.topics[1]))) continue;
      const rw = words(r.data); if (rw.length >= 2) { refundRaw += rw[1]; usdRaw = usdRaw > rw[1] ? usdRaw - rw[1] : BigInt(0); }
    }
    const usd = units(usdRaw, dec), tokens = units(tokRaw);
    // fee: venue fee scaled by this trade's own $/quote ratio (exact for USDG-quoted coins: quote = USDG)
    let feeUsd = 0;
    if (venue && venue.isBuy === isBuy && venue.quoteAmt > BigInt(0)) feeUsd = usd * (Number(venue.fee) / Number(venue.quoteAmt));
    return { side: isBuy ? "buy" : "sell", usd, tokens, feeUsd, source: "usdg", ...(refundRaw > BigInt(0) ? { refundUsd: units(refundRaw, dec) } : {}) };
  }
  if (!venue || venue.tokenAmt <= BigInt(0)) return null;
  // native-quote path: $ = quote raw × $/quote raw (curve: from mcapAfterUsd; hook: from the caller's mark)
  if (!(quoteUsdPerRaw > 0)) return null;
  return {
    side: venue.isBuy ? "buy" : "sell",
    usd: Number(venue.quoteAmt) * quoteUsdPerRaw,
    tokens: units(venue.tokenAmt),
    feeUsd: Number(venue.fee) * quoteUsdPerRaw,
    source: venue.hook ? "hook" : "curve",
  };
}

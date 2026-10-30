/**
 * SITE pre-send trade alerts (lee, Oct 26 10:50–10:52 CDT). Pure: the caller passes cached reads (no RPC on the tap).
 *  1. Wallet limit (buys): the coin's mode caps how much one wallet may hold (BondingCurve.netCapNow(), read by
 *     lib/flight/coinRules — never hardcoded). A buy that would go over it can't go through, so instead of letting it
 *     revert we say so and offer one tap to buy the max allowed.
 *  2. High price impact (buys and sells): over 10 % ⇒ a plain warning carried on the trade's result. The trade is sent
 *     immediately: never held, never a confirm tap (lee: price impact never blocks a trade; GAME review on #201).
 * Only the wallet limit holds a trade (with Buy max).
 * COPY PENDING LEE APPROVAL (the strings below).
 */
export const HIGH_IMPACT_BPS = 1000;   // 10 %
/** Buy-max sizing headroom: the fill's average price is above the mark, so usd / price overestimates the coins. */
export const BUY_MAX_HEADROOM = 0.97;

export type TradeAlert =
  | { kind: "walletcap"; text: string; capPct: string; maxUsd: number; actionLabel: string; dismissLabel: string }
  | { kind: "impact"; text: string; impactBps: number };

const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`;
const money = (usd: number) => (usd >= 1000 ? `$${(usd / 1000).toFixed(2)}K` : `$${usd.toFixed(2)}`);
const coins = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(n >= 10 ? 0 : 2));

/** COPY PENDING LEE APPROVAL */
export const COPY_PENDING_LEE = {
  walletCap: (capPct: string, maxUsd: number) => `Wallet limit: this coin's mode caps each wallet at ${capPct}. You can buy up to about ${money(maxUsd)} more.`,
  walletFull: (capPct: string) => `Wallet limit: this coin's mode caps each wallet at ${capPct}. You're already at the limit.`,
  buyMax: (maxUsd: number) => `Buy max (${money(maxUsd)})`,
  impactSell: (usd: number) => `High price impact: this sell moves the price over 10%. You'll get about ${money(usd)}.`,
  impactBuy: (coinsOut: number) => `High price impact: this buy moves the price over 10%. You'll get about ${coins(coinsOut)} coins.`,
  cancel: "Cancel",
};

export type CapInput = {
  /** cap in bps of supply (coinRules.capBps; null = no cap, e.g. TRENCH or graduated) */
  capBps: number | null;
  /** token units (not wei) */
  supply: number; holding: number; pendingBuyTokens?: number;
  priceUsd: number;
};
/** Wallet-limit check for a buy of `usd`. null = fine (or not enough data to tell: never blocks on a guess). */
export function walletCapAlert(usd: number, c: CapInput): Extract<TradeAlert, { kind: "walletcap" }> | null {
  if (c.capBps == null || !(c.capBps > 0) || !(c.supply > 0) || !(c.priceUsd > 0) || !(usd > 0)) return null;
  const capTokens = (c.capBps / 10_000) * c.supply;
  const room = capTokens - c.holding - (c.pendingBuyTokens ?? 0);
  const wantTokens = usd / c.priceUsd;   // at the mark: an upper bound on what the buy gets (avg fill price ≥ mark)
  if (wantTokens <= room) return null;
  const maxUsd = Math.max(0, Math.floor(room * c.priceUsd * BUY_MAX_HEADROOM * 100) / 100);
  const capPct = pct(c.capBps);
  return { kind: "walletcap", capPct, maxUsd, text: maxUsd >= 0.01 ? COPY_PENDING_LEE.walletCap(capPct, maxUsd) : COPY_PENDING_LEE.walletFull(capPct),
    actionLabel: maxUsd >= 0.01 ? COPY_PENDING_LEE.buyMax(maxUsd) : "", dismissLabel: COPY_PENDING_LEE.cancel };
}

/** > 10 % price impact ⇒ the warning text (sent with the trade, never a hold). impactBps null/unknown ⇒ no alert (never blocks on a guess). */
export function impactAlert(side: "buy" | "sell", impactBps: number | null | undefined, expected: { usdOut?: number; coinsOut?: number }): Extract<TradeAlert, { kind: "impact" }> | null {
  if (impactBps == null || !(impactBps > HIGH_IMPACT_BPS)) return null;
  const text = side === "sell" ? COPY_PENDING_LEE.impactSell(expected.usdOut ?? 0) : COPY_PENDING_LEE.impactBuy(expected.coinsOut ?? 0);
  return { kind: "impact", impactBps, text };
}

/** The one alert that HOLDS a trade: the wallet limit (buys). `confirmed` = kinds the player already tapped through.
 *  Price impact never holds (see impactAlert: a warning on the result). */
export function nextAlert(side: "buy" | "sell", usd: number, i: { cap?: CapInput | null },
  confirmed: ReadonlyArray<TradeAlert["kind"]> = []): Extract<TradeAlert, { kind: "walletcap" }> | null {
  if (side === "buy" && i.cap && !confirmed.includes("walletcap")) return walletCapAlert(usd, i.cap);
  return null;
}

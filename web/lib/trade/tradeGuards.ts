/**
 * SITE pre-send trade alerts (lee, Oct 26 10:50–10:52 CDT). Pure: the caller passes cached reads (no RPC on the tap).
 *  1. Wallet limit (buys): the coin's mode caps how much one wallet may hold (BondingCurve.netCapNow(), read by
 *     lib/flight/coinRules — never hardcoded). A buy over the room left FILLS THE WHOLE ROOM, silently (lee, Oct 31: "just fill
 *     the gap", no copy): buyFill sends a bit more than the room costs and the curve partial-fills to the cap and refunds
 *     the rest (BondingCurve._quoteBuy / BuyRefunded; router buys: UsdgRefund); minOut is priced on the room, not the
 *     sent $ (queuePricing.roomCappedRange). Only a wallet already at the limit (room 0: the curve would revert
 *     WalletCap) is held, with no Buy max.
 *  2. High price impact (buys and sells): over 10 % ⇒ a plain warning carried on the trade's result. The trade is sent
 *     immediately: never held, never a confirm tap (lee: price impact never blocks a trade; GAME review on #201).
 * Only a full wallet holds a trade (wallet limit, Cancel only).
 * COPY PENDING LEE APPROVAL (the strings below).
 */
export const HIGH_IMPACT_BPS = 1000;   // 10 %
/** Full-wallet test headroom (unchanged): the room is "0" (held) when 97 % of it at the mark is under 1¢. */
export const BUY_MAX_HEADROOM = 0.97;
/** Over-room buys send the room's $ at the mark × this (≤ the typed $, ≤ spendable cash): covers the 1 % protocol fee,
 *  the creator tax and the curve's price impact across the room, so the curve fills the WHOLE room and refunds the
 *  rest. Bounded (not the typed $) because a one-tap session's spend cap counts the gross amount sent. */
export const FILL_OVERSHOOT = 1.25;
/** minOut is priced on (room − 0.5 %): a stale balance / cap read can't make minOut ask for more than the chain's room. */
export const ROOM_MARGIN_BPS = 50;

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
/** The buy's room under the wallet limit, in $ at the mark with BUY_MAX_HEADROOM (floored to the cent); null = no cap /
 *  not enough data (never limits on a guess). */
function capRoom(c: CapInput): { maxUsd: number; capPct: string; room: number } | null {
  if (c.capBps == null || !(c.capBps > 0) || !(c.supply > 0) || !(c.priceUsd > 0)) return null;
  const capTokens = (c.capBps / 10_000) * c.supply;
  const room = capTokens - c.holding - (c.pendingBuyTokens ?? 0);
  const maxUsd = Math.max(0, Math.floor(room * c.priceUsd * BUY_MAX_HEADROOM * 100) / 100);
  // usd ≤ maxUsd ⇒ usd / mark (an upper bound on the coins: avg fill price ≥ mark) is ≤ 97 % of the room
  return { maxUsd, capPct: pct(c.capBps), room: Math.max(0, room) };
}
/** Wallet-limit HOLD for a buy of `usd`: only when the wallet is already at the limit (room < 1¢ — the curve would revert
 *  WalletCap). An over-room buy is not held: buyFill sends it at the room. null = fine (or not enough data to tell). */
export function walletCapAlert(usd: number, c: CapInput): Extract<TradeAlert, { kind: "walletcap" }> | null {
  if (!(usd > 0)) return null;
  const r = capRoom(c);
  if (!r || usd <= r.maxUsd || r.maxUsd >= 0.01) return null;
  return { kind: "walletcap", capPct: r.capPct, maxUsd: 0, text: COPY_PENDING_LEE.walletFull(r.capPct), actionLabel: "", dismissLabel: COPY_PENDING_LEE.cancel };
}
export type BuyFill = {
  /** $ to send */
  usd: number;
  /** over the room: the curve partial-fills + refunds; minOut must be priced on roomOut */
  capped: boolean;
  /** capped: minOut's token ceiling = room × (1 − ROOM_MARGIN_BPS), token units (not wei) */
  roomOut?: number;
  /** $ expected to really fill (optimistic display / pending-room bookkeeping): min(sent, room at the mark) */
  fillUsd: number;
};
/** Fill-to-limit (lee, Oct 31: fill the whole room, no copy). Over the room (usd > its 97 % at the mark) ⇒ send
 *  min(usd, room at the mark × FILL_OVERSHOOT, spendable cash) and price minOut on roomOut; the curve fills to the cap
 *  and refunds the unspent $. At / under the room, no cap, unknown data, or a full wallet (walletCapAlert holds that
 *  one) ⇒ `usd` unchanged. `cashUsd` = spendable cash (after pending + gas), unknown ⇒ not limited (the cash check
 *  decides). Pure / sync: cached reads only, no RPC on the tap. */
export function buyFill(usd: number, c: CapInput | null | undefined, cashUsd?: number | null): BuyFill {
  const r = c && usd > 0 ? capRoom(c) : null;
  if (!r || usd <= r.maxUsd || r.maxUsd < 0.01) return { usd, capped: false, fillUsd: usd };
  const roomUsd = r.room * c!.priceUsd;
  let send = Math.min(usd, Math.ceil(roomUsd * FILL_OVERSHOOT * 100 - 1e-6) / 100);
  if (cashUsd != null && Number.isFinite(cashUsd) && cashUsd >= 0.01) send = Math.min(send, Math.floor(cashUsd * 100) / 100);
  return { usd: send, capped: true, roomOut: (r.room * (10_000 - ROOM_MARGIN_BPS)) / 10_000, fillUsd: Math.min(send, Math.round(roomUsd * 1e6) / 1e6) };
}

/** > 10 % price impact ⇒ the warning text (sent with the trade, never a hold). impactBps null/unknown ⇒ no alert (never blocks on a guess). */
export function impactAlert(side: "buy" | "sell", impactBps: number | null | undefined, expected: { usdOut?: number; coinsOut?: number }): Extract<TradeAlert, { kind: "impact" }> | null {
  if (impactBps == null || !(impactBps > HIGH_IMPACT_BPS)) return null;
  const text = side === "sell" ? COPY_PENDING_LEE.impactSell(expected.usdOut ?? 0) : COPY_PENDING_LEE.impactBuy(expected.coinsOut ?? 0);
  return { kind: "impact", impactBps, text };
}

/** The one alert that HOLDS a trade: the wallet limit (buys), only when the wallet is already at it. `confirmed` = kinds the player already tapped through.
 *  Price impact never holds (see impactAlert: a warning on the result). */
export function nextAlert(side: "buy" | "sell", usd: number, i: { cap?: CapInput | null },
  confirmed: ReadonlyArray<TradeAlert["kind"]> = []): Extract<TradeAlert, { kind: "walletcap" }> | null {
  if (side === "buy" && i.cap && !confirmed.includes("walletcap")) return walletCapAlert(usd, i.cap);
  return null;
}

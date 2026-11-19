/**
 * Market and trades, shared rules (maker 2026-11-16: items become transferable in Disciple's own database first, NFTs later;
 * the market lives on the website only, never in the iPhone app; 7% total fee; no trade lock; no paid crates).
 *
 * A copy only ever changes hands as a sale, so every move pays the 7% (maker 2026-11-19: "items can't be transferred
 * outside of marketplace otherwise they would bypass our fee"; item-for-item swaps were cut the same day):
 *   - Listing: a pilot lists one copy for a dollar price; a buyer pays in USDG (Cash) from their own wallet. One signed
 *     gasless transfer pays the seller the price minus 7% and the fee + network fee to Disciple, then the copy moves.
 *   - Private sale: a listing with `to` set. It never shows on /market and only that pilot can buy it.
 *   - Cash offer: a pilot offers a price for any tradable copy. No money is held. If the owner accepts, the offer becomes
 *     a private sale to the offerer at that price, open for OFFER_PAY_MS; they pay through the normal buy.
 * Every price, private or offered, is at least MIN_PRICE_CENTS (maker 2026-11-19: no $0 sales).
 * Server: lib/server/market.ts. A copy keeps its uid, serial, rolls and history when it moves, so it can become one token later.
 */
import type { Copy, Item } from "./collection";

/** Disciple's cut of a sale, in basis points (7%). */
export const MARKET_FEE_BPS = 700;
/** Prices are whole cents. $1 to $10,000. */
export const MIN_PRICE_CENTS = 100;
export const MAX_PRICE_CENTS = 1_000_000;
/** A cash offer lasts a week; once accepted, the offerer has a day to pay. A pilot keeps at most OFFER_MAX open offers. */
export const OFFER_MAX = 20;
export const OFFER_TTL_MS = 7 * 86_400_000;
export const OFFER_PAY_MS = 86_400_000;

/** The fee on a price, rounded up to the cent. */
export const marketFeeCents = (price: number) => Math.ceil((price * MARKET_FEE_BPS) / 10_000);
/** What the seller gets. */
export const sellerCents = (price: number) => price - marketFeeCents(price);
/** cents → USDG raw units */
export const centsToRaw = (cents: number, decimals: number) => BigInt(cents) * BigInt(10) ** BigInt(Math.max(0, decimals - 2));
export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "$12.50" / "12.5" / "12" → cents, or null */
export function parsePrice(v: string): number | null {
  const t = v.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,7}(\.\d{0,2})?$/.test(t)) return null;
  const c = Math.round(Number(t) * 100);
  return c >= MIN_PRICE_CENTS && c <= MAX_PRICE_CENTS ? c : null;
}

export type ListingState = "open" | "pending" | "sold" | "closed";
export interface Listing {
  id: string; uid: string; item: string; seller: string; price: number; at: number; state: ListingState;
  buyer?: string; tx?: string; soldAt?: number;
  /** private sale: only this wallet can buy it, and it never shows on /market */
  to?: string;
  /** made by accepting this cash offer (closes after OFFER_PAY_MS) */
  offer?: string; until?: number;
  /** filled in on reads: the copy as it is now, and the seller's (and private buyer's) name */
  copy?: Copy; sellerName?: string | null; toName?: string | null;
}
export interface Sale { listing: string; uid: string; item: string; serial: number; burn: number; price: number; at: number }

/** open → accepted (a private sale is waiting on the offerer) → paid; or declined / cancelled / expired / lapsed (accepted, not paid). */
export type OfferState = "open" | "accepted" | "paid" | "declined" | "cancelled" | "expired" | "lapsed";
/** A cash offer from `from` for one copy `to` holds. */
export interface Offer {
  id: string; from: string; to: string; uid: string; item: string; price: number; at: number; state: OfferState; doneAt?: number;
  /** the private sale made when it was accepted */
  listing?: string;
  /** filled in on reads */
  copy?: Copy; fromName?: string | null; toName?: string | null;
}

/** Why a copy can't move, or null when it can. `listed` / `frozen` / `worn` come from the server. */
export function cantMove(c: Copy | undefined, o: { worn?: boolean; listed?: boolean; frozen?: boolean } = {}): string | null {
  if (!c) return "That copy isn't there any more.";
  if (c.origin === "starter") return "Starter items never trade.";
  if (c.bound) return "That copy never trades.";
  if (o.frozen) return "That copy is frozen while we look into it.";
  if (o.worn) return "Take it off before you trade it.";
  if (o.listed) return "It's on the market. Take it off first.";
  return null;
}

export type MarketSort = "new" | "price-asc" | "price-desc" | "burn-asc";
export interface MarketFilter { item?: string; kind?: Item["kind"]; rar?: Item["rar"]; series?: number; trak?: boolean; sort?: MarketSort; limit?: number }

export type MarketAction =
  | { op: "list"; copy: string; price: number; to?: string }
  | { op: "unlist"; listing: string }
  | { op: "offer"; copy: string; price: number }
  | { op: "accept" | "decline" | "cancel"; offer: string }
  | { op: "buy"; listing: string; request: unknown };

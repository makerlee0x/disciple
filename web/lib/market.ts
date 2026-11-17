/**
 * Market and trades, shared rules (maker 2026-11-16: items become transferable in Disciple's own database first, NFTs later;
 * the market lives on the website only, never in the iPhone app; 7% total fee; no trade lock; no paid crates).
 *
 * Two ways a copy changes hands:
 *   - Trade offer: copies for copies between two pilots, both agree. No money. Works in the app too.
 *   - Market: a pilot lists one copy for a dollar price; a buyer pays in USDG (Cash) from their own wallet. One signed
 *     gasless transfer pays the seller the price minus 7% and the fee + network fee to Disciple, then the copy moves.
 * Server: lib/server/market.ts. A copy keeps its uid, serial, rolls and history when it moves, so it can become one token later.
 */
import type { Copy, Item } from "./collection";

/** Disciple's cut of a sale, in basis points (7%). */
export const MARKET_FEE_BPS = 700;
/** Prices are whole cents. $1 to $10,000. */
export const MIN_PRICE_CENTS = 100;
export const MAX_PRICE_CENTS = 1_000_000;
/** A trade offer holds at most this many copies a side, and lasts a week. */
export const OFFER_MAX = 8;
export const OFFER_TTL_MS = 7 * 86_400_000;

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
  /** filled in on reads: the copy as it is now, and the seller's name */
  copy?: Copy; sellerName?: string | null;
}
export interface Sale { listing: string; uid: string; item: string; serial: number; burn: number; price: number; at: number }

export type OfferState = "open" | "accepted" | "declined" | "cancelled" | "expired" | "failed";
export interface Offer {
  id: string; from: string; to: string; give: string[]; want: string[]; at: number; state: OfferState; doneAt?: number; note?: string;
  /** filled in on reads */
  giveCopies?: Copy[]; wantCopies?: Copy[]; fromName?: string | null; toName?: string | null;
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
  | { op: "list"; copy: string; price: number }
  | { op: "unlist"; listing: string }
  | { op: "offer"; to: string; give: string[]; want: string[] }
  | { op: "accept" | "decline" | "cancel"; offer: string }
  | { op: "buy"; listing: string; request: unknown };

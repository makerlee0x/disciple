/**
 * Turbo routes (v2.1, maker signed off Nov 13 2026: "a completely different sky for BTC versus ETH, so the quest feels
 * different"). Each market is a route with its own pad, flight sky and button colour. The art is the existing pad and
 * tier plates re-graded per route (public/turbo/*.webp), so nothing new had to be drawn.
 */
import type { Market } from "./types";

export interface TurboRoute {
  market: Market;
  /** Engine key for the flight sky (public/turbo/sky-<key>.webp). */
  key: "btc" | "eth";
  no: string;
  name: string;
  tagline: string;
  pad: string;
  thumb: string;
  /** CSS custom properties set on the Turbo page: accent, soft accent, accent text, ink on accent, glass, line. */
  vars: Record<string, string>;
}

export const ROUTES: Record<Market, TurboRoute> = {
  BTC: {
    market: "BTC", key: "btc", no: "01", name: "SUN ROUTE", tagline: "Ride Bitcoin into the dawn.",
    pad: "/turbo/pad-btc.webp", thumb: "/turbo/thumb-btc.webp",
    vars: { "--r-acc": "#F2C14E", "--r-acc-soft": "rgba(242,193,78,.14)", "--r-acc-text": "#F3DFA8", "--r-ink": "#121327", "--r-glass": "rgba(26,14,16,.82)", "--r-line": "#4A3328", "--r-glow": "rgba(242,193,78,.7)" },
  },
  ETH: {
    market: "ETH", key: "eth", no: "02", name: "MOON ROUTE", tagline: "Ride Ether past the moon.",
    pad: "/turbo/pad-eth.webp", thumb: "/turbo/thumb-eth.webp",
    vars: { "--r-acc": "#8FE3FF", "--r-acc-soft": "rgba(143,227,255,.14)", "--r-acc-text": "#CFF4FF", "--r-ink": "#0E0B2E", "--r-glass": "rgba(14,12,40,.82)", "--r-line": "#332E66", "--r-glow": "rgba(143,227,255,.7)" },
  },
};

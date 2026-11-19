/** Quote address → pair bucket + display symbol (moved verbatim from the old app/page.tsx; shared by the hero + feed). */
import { recommendedPairs } from "@/lib/pairs";
import { whitelistQuoteByAddress } from "@/lib/whitelistQuotes";

export const shortHex = (a: string) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");

export function pairOf(quote: string): "STRATEGY" | "USDG" | "OTHER" {
  const q = (quote || "").toLowerCase();
  const ps = recommendedPairs();
  if (!q || /^0x0+$/.test(q) || q === ps[0]?.address.toLowerCase()) return "STRATEGY";
  if (ps[1] && q === ps[1].address.toLowerCase()) return "USDG";
  return "OTHER";
}

export function pairSymOf(quote: string): string {
  const k = pairOf(quote);
  // a listed pair coin shows its symbol (AI, PENGU, …); only an unknown quote falls back to its address
  if (k === "OTHER") return whitelistQuoteByAddress(quote)?.symbol ?? shortHex(quote);
  return k === "USDG" ? (recommendedPairs()[1]?.symbol ?? "USDG") : "STRATEGY";
}

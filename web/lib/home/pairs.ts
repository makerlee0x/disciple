/** Quote address → pair bucket + display symbol (moved verbatim from the old app/page.tsx; shared by the hero + feed). */
import { deployment } from "@/lib/chains";
import { recommendedPairs } from "@/lib/pairs";

export const shortHex = (a: string) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");

/** STRATEGY (default / address(0)), USDG (older rockets launched before the whitelist), else OTHER (a whitelisted coin). */
export function pairOf(quote: string): "STRATEGY" | "USDG" | "OTHER" {
  const q = (quote || "").toLowerCase();
  if (!q || /^0x0+$/.test(q) || q === recommendedPairs()[0]?.address.toLowerCase()) return "STRATEGY";
  if (q === deployment().usdg.toLowerCase()) return "USDG";
  return "OTHER";
}

export function pairSymOf(quote: string): string {
  const k = pairOf(quote);
  if (k === "STRATEGY") return "STRATEGY";
  if (k === "USDG") return "USDG";
  return recommendedPairs().find((p) => p.address.toLowerCase() === quote.toLowerCase())?.symbol ?? shortHex(quote);
}

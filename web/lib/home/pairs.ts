/** Quote address → pair bucket + display symbol (moved verbatim from the old app/page.tsx; shared by the hero + feed). */
import { recommendedPairs } from "@/lib/pairs";
import { OPTIONAL_QUOTES, WHITELIST_QUOTES } from "@/lib/whitelistQuotes";

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
  // a whitelisted base pair (SCHIFFY, PENGU…) by its symbol; only an unknown quote falls back to its short address
  if (k === "OTHER") return listedQuote(quote)?.symbol ?? shortHex(quote);
  return k === "USDG" ? (recommendedPairs()[1]?.symbol ?? "USDG") : "STRATEGY";
}

const LISTED = [...WHITELIST_QUOTES, ...OPTIONAL_QUOTES];
const listedQuote = (quote: string) => {
  const q = (quote || "").toLowerCase();
  return LISTED.find((x) => x.address.toLowerCase() === q);
};

/** Base pair logo for a pair symbol (mUSDG on testnet = USDG); null for an unlisted quote. */
export function pairLogoSrc(sym: string): string | null {
  const s = (sym || "").toUpperCase().replace(/^M(?=USDG$)/, "");
  return LISTED.find((x) => x.symbol === s)?.imagePath ?? null;
}

/** True when the pair symbol is a real coin symbol (not a short-address fallback). */
export const isNamedPair = (sym: string) => !!sym && !sym.startsWith("0x");

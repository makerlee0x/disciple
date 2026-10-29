/**
 * Curated quote-token list for the /create pair picker (FOMO-style token list).
 * Only tokens with a real address on the active chain are listed. Anything else → "Paste ERC-20".
 */
import { ACTIVE_CHAIN, ZERO, deployment } from "./chains";
import { STRATEGY_TOKEN } from "./config";
import type { Address } from "./protocol";

export interface PairOption {
  symbol: string; name: string; address: Address; note: string; recommended?: boolean; tint: string;
}

export function recommendedPairs(): PairOption[] {
  const d = deployment();
  const testnet = ACTIVE_CHAIN.id === 46630;
  const out: PairOption[] = [];
  const strat = (d.defaultQuote && d.defaultQuote !== ZERO ? d.defaultQuote : STRATEGY_TOKEN.address) as Address;
  out.push({
    symbol: "STRATEGY", name: testnet ? "Strategy Coin (test)" : "Strategy Coin", address: strat,
    note: "Default pair · launchpad default quote", recommended: true, tint: "#C9CED6",
  });
  if (d.usdg && d.usdg !== ZERO) {
    out.push({
      symbol: testnet ? "mUSDG" : "USDG", name: testnet ? "Test USDG" : "Global Dollar", address: d.usdg,
      note: "Stablecoin pair · rockets priced in dollars", tint: "#9ff3c8",
    });
  }
  return out;
}

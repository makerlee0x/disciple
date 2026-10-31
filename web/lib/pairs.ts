/**
 * Curated quote-token list for the /create pair picker (FOMO-style token list): the launch pair whitelist
 * (lib/pairWhitelist), STRATEGY first as the default. No USDG / ETH / pasted ERC-20 (lee 2026-10-29).
 */
import { ACTIVE_CHAIN } from "./chains";
import { basePair } from "./pairArt";
import { pairWhitelist } from "./pairWhitelist";
import type { Address } from "./protocol";

export interface PairOption {
  symbol: string; name: string; address: Address; note: string; recommended?: boolean; tint: string;
  /** pair-art key: /public/pairs/<tk>.png (lib/pairArt pairLogo) */
  tk: string;
}

export function recommendedPairs(): PairOption[] {
  const testnet = ACTIVE_CHAIN.id === 46630;
  return pairWhitelist(ACTIVE_CHAIN.id).map((p, i) => ({
    symbol: p.symbol, name: testnet && i === 0 ? `${p.name} (test)` : p.name, address: p.address, tk: p.tk,
    note: i === 0 ? "Default pair" : "Community coin",
    recommended: i === 0, tint: basePair(p.symbol)?.tint ?? "#C9CED6",
  }));
}

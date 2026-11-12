/**
 * Launch pair whitelist for the Quick Launch pair picker.
 *
 * Coins, names, addresses, decimals, and images come from main's
 * `web/lib/whitelistQuotes.ts` (the 12-coin list FLOW shipped). The router
 * already knows the quote route for each coin (a two-swap route for the seven
 * LONG coins STRATEGY, AI, SCHIFFY, BONER, MEME, MOO, and SPACEHOOD, and a
 * single USDG swap for the other five). This file does not invent a second
 * quote path.
 *
 * STRATEGY is the default. USDG is intentionally not listed.
 * On testnet, only STRATEGY works: `addressOn()` uses the chain's defaultQuote,
 * and `launchPairsForChain()` offers only STRATEGY. There are no mock testnet coins.
 */
import type { Address } from "./protocol";
import { MAINNET_CHAIN_ID } from "./networkConfig";
import { WHITELIST_QUOTES } from "./whitelistQuotes";

export type LaunchWhitelistCoin = {
  symbol: string;
  name: string;
  address: Address;
  /** Public path to the 256px token image (FLOW, Nov 10 2026). */
  image: string;
  decimals: number;
};

export const LAUNCH_WHITELIST: readonly LaunchWhitelistCoin[] = WHITELIST_QUOTES.map((q) => ({
  symbol: q.symbol,
  name: q.name,
  address: q.address,
  image: q.imagePath,
  decimals: q.decimals,
}));

/** The chip selected when the form opens. */
export const DEFAULT_LAUNCH_PAIR_SYMBOL = "STRATEGY" as const;

export const defaultLaunchPair = (): LaunchWhitelistCoin => {
  const found = LAUNCH_WHITELIST.find((c) => c.symbol === DEFAULT_LAUNCH_PAIR_SYMBOL);
  if (!found) throw new Error("launch whitelist is missing the default pair");
  return found;
};

/** Pairs the picker should offer on this chain. Testnet: STRATEGY only. */
export function launchPairsForChain(chainId: number): readonly LaunchWhitelistCoin[] {
  if (chainId === MAINNET_CHAIN_ID) return LAUNCH_WHITELIST;
  return LAUNCH_WHITELIST.filter((c) => c.symbol === DEFAULT_LAUNCH_PAIR_SYMBOL);
}

export const isUsdgSymbol = (symbol: string) => /^m?usdg$/i.test(symbol.trim());

/** True when this list contains a USDG / mUSDG option (it must not). */
export const whitelistIncludesUsdg = (list: readonly LaunchWhitelistCoin[] = LAUNCH_WHITELIST) =>
  list.some((c) => isUsdgSymbol(c.symbol));

/**
 * Address to send as the launch quote token. On mainnet this is the listed
 * address. On any other chain, STRATEGY uses `defaultQuote` (the deployment's
 * test STRATEGY), because the listed address is the mainnet token.
 */
export function addressOn(
  coin: LaunchWhitelistCoin,
  chainId: number,
  defaultQuote: Address | null | undefined,
): Address {
  if (coin.symbol === "STRATEGY" && chainId !== MAINNET_CHAIN_ID && defaultQuote) return defaultQuote;
  return coin.address;
}

export function coinByAddress(
  address: string | null | undefined,
  chainId: number,
  defaultQuote: Address | null | undefined,
): LaunchWhitelistCoin | undefined {
  if (!address) return undefined;
  const needle = address.toLowerCase();
  return LAUNCH_WHITELIST.find((c) => addressOn(c, chainId, defaultQuote).toLowerCase() === needle);
}

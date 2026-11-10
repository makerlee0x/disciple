/**
 * Launch pair whitelist (lee, Nov 10 2026, 3:47 PM CT).
 *
 * ONE config the Quick Launch "Pair coin" chips read from. FLOW can later fill or
 * replace this file (addresses, names, or `image` paths) when a backend list is
 * wired; keep this shape: symbol, name, address, image, decimals.
 *
 * Order is lee's order. STRATEGY is the default. USDG is intentionally not listed.
 * Addresses and names come from /workspace/notes/launch-whitelist-2026-11-10.md and
 * FLOW's /workspace/whitelist-images/manifest.json (mainnet, Robinhood Chain 4663).
 * Images are the 256px copies under /pairs/launch/.
 *
 * On testnet (46630), `addressOn()` uses the chain's defaultQuote for STRATEGY.
 * The other eleven addresses are mainnet-only until FLOW fills testnet values.
 */
import type { Address } from "./protocol";
import { MAINNET_CHAIN_ID } from "./networkConfig";

export type LaunchWhitelistCoin = {
  symbol: string;
  name: string;
  address: Address;
  /** Public path to the 256px token image (FLOW, Nov 10 2026). */
  image: string;
  decimals: number;
};

const img = (symbol: string) => `/pairs/launch/${symbol.toLowerCase()}.png`;

export const LAUNCH_WHITELIST: readonly LaunchWhitelistCoin[] = [
  { symbol: "STRATEGY", name: "Strategy Coin", address: "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18", image: img("STRATEGY"), decimals: 18 },
  { symbol: "AI", name: "Artificial Inu", address: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18", image: img("AI"), decimals: 18 },
  { symbol: "SCHIFFY", name: "SCHIFFY", address: "0x42aFA2124ca5a2B83898E46B2dA9a190995b1E18", image: img("SCHIFFY"), decimals: 18 },
  { symbol: "BONER", name: "Boner Coin", address: "0x98096d17e191B3dA1d5f99a6D7b3584351b11E18", image: img("BONER"), decimals: 18 },
  { symbol: "MEME", name: "A Meme Coin", address: "0x385F4f8ae47651ce5F58F5265395a669f8281e18", image: img("MEME"), decimals: 18 },
  { symbol: "MOO", name: "Memory cow Moo", address: "0xD9dB30BB0D2b8d2eae3826A1372117E058791e18", image: img("MOO"), decimals: 18 },
  { symbol: "PONS", name: "Pons", address: "0x39dBED3a2bd333467115dE45665cC57F813C4571", image: img("PONS"), decimals: 18 },
  { symbol: "ORBIO", name: "Orbio.so", address: "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3", image: img("ORBIO"), decimals: 18 },
  { symbol: "HOOKR", name: "Hookr.fun", address: "0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c", image: img("HOOKR"), decimals: 18 },
  { symbol: "CASHCAT", name: "Cash Cat", address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", image: img("CASHCAT"), decimals: 18 },
  { symbol: "PRIORS", name: "Priors Agents", address: "0xeDBf91223639800BCd5756815CAf908Df3b890bE", image: img("PRIORS"), decimals: 18 },
  { symbol: "BUN", name: "Bundle Cat", address: "0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2", image: img("BUN"), decimals: 18 },
];

/** The chip selected when the form opens. */
export const DEFAULT_LAUNCH_PAIR_SYMBOL = "STRATEGY" as const;

export const defaultLaunchPair = (): LaunchWhitelistCoin => {
  const found = LAUNCH_WHITELIST.find((c) => c.symbol === DEFAULT_LAUNCH_PAIR_SYMBOL);
  if (!found) throw new Error("launch whitelist is missing the default pair");
  return found;
};

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

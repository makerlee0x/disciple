/**
 * Launch-whitelist quote tokens for SITE's Quick Launch picker.
 * 12 coins. Owner wiring of router/pricer routes is a separate on-chain step
 * (see contracts/script/whitelist/README.md) and is never sent from the web app.
 *
 * Nov 16, 2026 (maker): MOO and SPACEHOOD removed, PENGU and HMM added.
 * Nov 17, 2026 (maker): HMM replaced by DELTA (single hop, unhooked 1.99% USDG/DELTA v4 pool).
 * Images live at /whitelist/<SYMBOL>.png (256×256 PNGs).
 *
 * USDG and ETH are built as optional pairs (OPTIONAL_QUOTES) that are OFF at launch.
 * Switch them on with NEXT_PUBLIC_PAIR_USDG=1 / NEXT_PUBLIC_PAIR_ETH=1 (lib/launchWhitelist.ts).
 */
export type WhitelistQuote = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  imagePath: string;
};

export const WHITELIST_QUOTES: readonly WhitelistQuote[] = [
  {
    symbol: "STRATEGY",
    name: "Strategy Coin",
    address: "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18",
    decimals: 18,
    imagePath: "/whitelist/STRATEGY.png",
  },
  {
    symbol: "AI",
    name: "Artificial Inu",
    address: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18",
    decimals: 18,
    imagePath: "/whitelist/AI.png",
  },
  {
    symbol: "SCHIFFY",
    name: "SCHIFFY",
    address: "0x42aFA2124ca5a2B83898E46B2dA9a190995b1E18",
    decimals: 18,
    imagePath: "/whitelist/SCHIFFY.png",
  },
  {
    symbol: "BONER",
    name: "Boner Coin",
    address: "0x98096d17e191B3dA1d5f99a6D7b3584351b11E18",
    decimals: 18,
    imagePath: "/whitelist/BONER.png",
  },
  {
    symbol: "MEME",
    name: "A Meme Coin",
    address: "0x385F4f8ae47651ce5F58F5265395a669f8281e18",
    decimals: 18,
    imagePath: "/whitelist/MEME.png",
  },
  {
    symbol: "PONS",
    name: "Pons",
    address: "0x39dBED3a2bd333467115dE45665cC57F813C4571",
    decimals: 18,
    imagePath: "/whitelist/PONS.png",
  },
  {
    symbol: "ORBIO",
    name: "Orbio.so",
    address: "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3",
    decimals: 18,
    imagePath: "/whitelist/ORBIO.png",
  },
  {
    symbol: "HOOKR",
    name: "Hookr.fun",
    address: "0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c",
    decimals: 18,
    imagePath: "/whitelist/HOOKR.png",
  },
  {
    symbol: "CASHCAT",
    name: "Cash Cat",
    address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
    decimals: 18,
    imagePath: "/whitelist/CASHCAT.png",
  },
  {
    symbol: "PRIORS",
    name: "Priors Agents",
    address: "0xeDBf91223639800BCd5756815CAf908Df3b890bE",
    decimals: 18,
    imagePath: "/whitelist/PRIORS.png",
  },
  {
    symbol: "PENGU",
    name: "Pudgy Penguins",
    address: "0x74BE72AFFAFbC8de30F0C11247814036314D625f",
    decimals: 18,
    imagePath: "/whitelist/PENGU.png",
  },
  {
    symbol: "DELTA",
    name: "Delta",
    address: "0xe8ffd7e24187F72afB08d75B1bb13088A989a791",
    decimals: 18,
    imagePath: "/whitelist/DELTA.png",
  },
] as const;

/**
 * Optional pairs, built but OFF at launch (maker, Nov 16 2026). Not part of WHITELIST_QUOTES, so the
 * picker never shows them unless their switch is on (lib/launchWhitelist.ts).
 * ETH is listed as WETH (an ERC-20); address(0) as a quote means "launchpad default" on-chain.
 */
export const OPTIONAL_QUOTES: readonly WhitelistQuote[] = [
  {
    symbol: "USDG",
    name: "Global Dollar",
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    decimals: 6,
    imagePath: "/whitelist/USDG.png",
  },
  {
    symbol: "ETH",
    name: "Ether",
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    decimals: 18,
    imagePath: "/whitelist/ETH.png",
  },
] as const;

export const whitelistQuoteByAddress = (address: string): WhitelistQuote | undefined => {
  const needle = address.toLowerCase();
  return WHITELIST_QUOTES.find((q) => q.address.toLowerCase() === needle);
};

export const whitelistQuoteBySymbol = (symbol: string): WhitelistQuote | undefined => {
  const needle = symbol.toUpperCase();
  return WHITELIST_QUOTES.find((q) => q.symbol === needle);
};

/** Pair coin logo by symbol, launch list or optional pairs (mUSDG on testnet = USDG); null for an unlisted quote. */
export const pairLogoBySymbol = (symbol: string): string | null => {
  const s = (symbol || "").toUpperCase().replace(/^MUSDG$/, "USDG");
  return [...WHITELIST_QUOTES, ...OPTIONAL_QUOTES].find((q) => q.symbol === s)?.imagePath ?? null;
};

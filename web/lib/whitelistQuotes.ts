/**
 * Launch-whitelist quote tokens for SITE's Quick Launch picker.
 * 12 coins. Owner wiring of router/pricer routes is a separate on-chain step
 * (see contracts/script/whitelist/README.md) and is never sent from the web app.
 *
 * BUN was removed on lee's instruction (Nov 10, 2026) and replaced the same day
 * with SPACEHOOD (stock-pool route via SPCX). Images live at /whitelist/<SYMBOL>.png
 * (256×256 PNGs).
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
    symbol: "MOO",
    name: "Memory cow Moo",
    address: "0xD9dB30BB0D2b8d2eae3826A1372117E058791e18",
    decimals: 18,
    imagePath: "/whitelist/MOO.png",
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
    symbol: "SPACEHOOD",
    name: "SPACEHOOD",
    address: "0xFe7E19CbCe2f896C6C528BC355bAF5a768291E18",
    decimals: 18,
    imagePath: "/whitelist/SPACEHOOD.png",
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

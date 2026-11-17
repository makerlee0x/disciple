/**
 * Launch-whitelist quote tokens for SITE's Quick Launch picker.
 * 12 coins. Owner wiring of router/pricer routes is a separate on-chain step
 * (see contracts/script/whitelist/README.md) and is never sent from the web app.
 *
 * Nov 16, 2026 (maker): SPACEHOOD removed and PENGU added. HMM was added, then swapped back out for MOO.
 * Nov 17, 2026: the testnet pair list also offers a DELTA stand-in (main replaced HMM with DELTA). MOO stays on this list.
 * Images live at /whitelist/<SYMBOL>.png (256×256 PNGs).
 * Testnet uses stand-ins for these coins (TESTNET_PAIR_QUOTES below).
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
    symbol: "PENGU",
    name: "Pudgy Penguins",
    address: "0x74BE72AFFAFbC8de30F0C11247814036314D625f",
    decimals: 18,
    imagePath: "/whitelist/PENGU.png",
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

/**
 * Robinhood testnet (46630) stand-ins for the pair coins, so every pair can be tested there.
 * Deployed Nov 16, 2026 by contracts/script/testnet/SeedTestnetLaunchCoins.s.sol and routed on the testnet
 * pricer and router (contracts/deployments/testnet-launch-coins.json). Each is a mintable test token
 * with 18 decimals. STRATEGY on testnet is the deployment's defaultQuote (see addressOn in lib/launchWhitelist.ts).
 */
export const TESTNET_STAND_INS: Readonly<Record<string, `0x${string}`>> = {
  AI: "0x242bb0b81336bb8A81fB8bBD05f075170bB6F982",
  SCHIFFY: "0xa6f590e1E933eD1CB069e6189d26bE894468FD1F",
  BONER: "0x9605EEE2Ee3acBED13b0e543258bcD45855B4eC4",
  MEME: "0x8a1D4BEA07DB5660cFC296037C70F57658f431A1",
  MOO: "0x79C4ba81AAd571819d9Ee96eC8A5c2fAF3bf7763",
  PONS: "0xF2824658E380C3c772Ced713EfafA08754c25ac7",
  ORBIO: "0x1989598A72114C2B13FcDBf3723dcC6D51C99A1B",
  HOOKR: "0x000ceC153598d1bbF5Bb485a9B4F9A976826B5fc",
  CASHCAT: "0x965d5141e1a07dD219450b311728a51822dCFce1",
  PRIORS: "0x7097BcbeD36d4De0F72e3BD93D943e2EbD4914f1",
  PENGU: "0x5E73fE55007db8223Ab5954b41899a013B94B73D",
  DELTA: "0x4853E82e0606D91C7915889C0eCB7C3DB733592b",
};

/** Testnet pair coins after STRATEGY: the mainnet list in the same order, with testnet addresses, plus DELTA (test). */
export const TESTNET_PAIR_QUOTES: readonly WhitelistQuote[] = [
  ...WHITELIST_QUOTES.filter((q) => q.symbol !== "STRATEGY").map((q) => ({
    ...q,
    name: `${q.name} (test)`,
    address: TESTNET_STAND_INS[q.symbol],
  })),
  {
    symbol: "DELTA",
    name: "Delta (test)",
    address: TESTNET_STAND_INS.DELTA,
    decimals: 18,
    imagePath: "/whitelist/DELTA.png",
  },
];

export const whitelistQuoteByAddress = (address: string): WhitelistQuote | undefined => {
  const needle = address.toLowerCase();
  return WHITELIST_QUOTES.find((q) => q.address.toLowerCase() === needle);
};

export const whitelistQuoteBySymbol = (symbol: string): WhitelistQuote | undefined => {
  const needle = symbol.toUpperCase();
  return WHITELIST_QUOTES.find((q) => q.symbol === needle);
};

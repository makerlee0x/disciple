/** DISCIPLE chain + game config — contracts can wire addresses later. */

export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://explorer.robinhood.com", // TBD
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
} as const;

/** Demo live pool: AI/WETH Uniswap v3 on Robinhood Chain */
export const DEMO_POOL = {
  address: "0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d" as const,
  name: "Artificial Inu",
  ticker: "AI / WETH",
  dex: "Uniswap v3",
  fee: 10000,
  tickSpacing: 200,
};

export const CURVE = {
  startMcap: 7_000,
  graduationMcap: 33_000,
  soldPctAtGrad: 72,
  totalSupply: 7_000_000_000,
  decimals: 18,
  walletCapPct: 7,
  tradeFeeBps: 100, // 1%
  creatorTaxMaxPct: 7,
  antiSnipeStartPct: 77.7,
  antiSnipeWindowSec: 7,
} as const;

/** 18-tier biblically ascending ladder (constitution LOCKED 2026-10-15) */
export const TIERS = [
  { name: "LAUNCH PAD", lo: 7e3, hi: 12e3, bg: "tier0" },
  { name: "LIMBO", lo: 12e3, hi: 18e3, bg: "tier1" },
  { name: "ASCENSION", lo: 18e3, hi: 25e3, bg: "tier2" },
  { name: "NARROW GATE", lo: 25e3, hi: 33e3, bg: "tier3" },
  { name: "PEARLY GATES", lo: 33e3, hi: 55e3, bg: "tier4" },
  { name: "FIRMAMENT", lo: 55e3, hi: 100e3, bg: "tier5" },
  { name: "ANGELS", lo: 100e3, hi: 333e3, bg: "tier6" },
  { name: "ARCHANGELS", lo: 333e3, hi: 777e3, bg: "tier7" },
  { name: "HEAVENLY HOST", lo: 777e3, hi: 1.2e6, bg: "tier8" },
  { name: "MORNING STARS", lo: 1.2e6, hi: 3.3e6, bg: "tier9" },
  { name: "VIRTUES", lo: 3.3e6, hi: 7.7e6, bg: "tier0" },
  { name: "DOMINIONS", lo: 7.7e6, hi: 33e6, bg: "tier1" },
  { name: "THRONE ROOM", lo: 33e6, hi: 77e6, bg: "tier2" },
  { name: "CHERUBIM", lo: 77e6, hi: 120e6, bg: "tier3" },
  { name: "SERAPHIM", lo: 120e6, hi: 777e6, bg: "tier4" },
  { name: "AETHER", lo: 777e6, hi: 1.2e9, bg: "tier5" },
  { name: "EMPYREAN", lo: 1.2e9, hi: 3.3e9, bg: "tier6" },
  { name: "SEVENTH HEAVEN", lo: 3.3e9, hi: 7.77e9, bg: "tier7" },
] as const;

export const MODES = [
  { key: "1", name: "FEATHER", usd: 0.01, range: "swarm label" },
  { key: "2", name: "EMBER", usd: 0.5, range: "swarm label" },
  { key: "3", name: "FLARE", usd: 5, range: "Launch Pad–Narrow Gate" },
  { key: "4", name: "COMET", usd: 10, range: "Pearly Gates–Angels" },
  { key: "5", name: "ARCHANGEL", usd: 100, range: "Angels–Virtues" },
  { key: "6", name: "GLORY", usd: 1000, range: "≥$33M (Dominions+)" },
] as const;

/** Sell bomb tiers by price impact % (constitution LOCKED) */
export const BOMB_PCT = {
  GRENADE: 2,
  BUNKER: 5,
  CRUISE: 12,
  NUKE: 25,
  ATOM: 50,
} as const;

export const BOMB_TIERS = [
  { k: "puff", name: "BRAKE", min: 0 },
  { k: "grenade", name: "GRENADE", min: BOMB_PCT.GRENADE },
  { k: "bunker", name: "BUNKER BUSTER", min: BOMB_PCT.BUNKER },
  { k: "cruise", name: "CRUISE MISSILE", min: BOMB_PCT.CRUISE },
  { k: "nuke", name: "NUKE", min: BOMB_PCT.NUKE },
  { k: "atom", name: "ATOM BOMB", min: BOMB_PCT.ATOM },
] as const;

export const GAS = {
  execGas: 200_000,
  ethUsd: 2372,
  robinhoodGwei: 0.0207,
  maxOverhead: 0.05,
} as const;

export function minShotUsd(
  gwei = GAS.robinhoodGwei,
  ethUsd = GAS.ethUsd,
): number {
  const gasUsd = GAS.execGas * gwei * 1e-9 * ethUsd;
  return gasUsd / GAS.maxOverhead;
}

export function fmtUsd(v: number): string {
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

export function gradProgress(mcap: number | null): number | null {
  if (mcap == null) return null;
  if (mcap >= CURVE.graduationMcap) return 100;
  return Math.max(
    0,
    Math.min(
      100,
      ((mcap - CURVE.startMcap) / (CURVE.graduationMcap - CURVE.startMcap)) *
        100,
    ),
  );
}

export const SETTINGS_KEYS = {
  orbs: "disciple.orbs",
  bombs: "disciple.bombs",
  shake: "disciple.shake",
  sidebarHome: "disciple.sidebar.home",
  sidebarGame: "disciple.sidebar.game",
} as const;

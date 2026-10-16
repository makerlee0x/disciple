/**
 * Base-pair registry for the pair art (coin square + base-pair coin). Assets are pre-rendered by
 * scripts/pair-art/gen.py into /public/pairs (logo, chrome coin, small coin) and /public/pair-art.
 */
import { withBase } from "./base-path";

export type BasePair = { tk: string; sym: string; name: string; tint: string; real: boolean; source: string };

export const BASE_PAIRS: BasePair[] = [
  { tk: "strategy", sym: "STRATEGY", name: "Strategy Coin", tint: "#ffe7a3", real: true, source: "Maker-provided" },
  { tk: "usdg", sym: "USDG", name: "Global Dollar", tint: "#c8e86a", real: true, source: "Maker-provided (AVIF)" },
  { tk: "eth", sym: "ETH", name: "Ether", tint: "#cfd3dc", real: true, source: "Maker-provided" },
  { tk: "ai", sym: "AI", name: "Artificial Inu", tint: "#c7f56b", real: true, source: "Maker-provided" },
  { tk: "boner", sym: "BONER", name: "Boner Coin", tint: "#e8c46a", real: true, source: "Maker-provided" },
  { tk: "pons", sym: "PONS", name: "Pons", tint: "#d9e6dc", real: true, source: "Maker-provided" },
  { tk: "moo", sym: "MOO", name: "Memory cow Moo", tint: "#c7f56b", real: true, source: "DexScreener (Robinhood)" },
  { tk: "orbio", sym: "ORBIO", name: "Orbio.so", tint: "#d8d8e0", real: true, source: "Maker-provided" },
  { tk: "zzz", sym: "ZZZ", name: "ZZZ", tint: "#e6e6e6", real: true, source: "Maker-provided" },
  { tk: "delta", sym: "DELTA", name: "Delta", tint: "#9ff3c8", real: true, source: "DexScreener (Robinhood)" },
  { tk: "shroom", sym: "SHROOM", name: "MUSHROOM", tint: "#f0dcb4", real: true, source: "DexScreener (Robinhood)" },
  { tk: "bow", sym: "BOW", name: "Longbow", tint: "#c9a86a", real: true, source: "DexScreener (Robinhood)" },
  { tk: "mstr", sym: "MSTR", name: "Strategy Inc.", tint: "#e97232", real: true, source: "Maker-provided (Strategy₿ wordmark)" },
  { tk: "nvda", sym: "NVDA", name: "NVIDIA", tint: "#76b900", real: true, source: "Maker-provided (cropped to eye mark)" },
  { tk: "spcx", sym: "SPCX", name: "SpaceX", tint: "#d8dce8", real: true, source: "Simple Icons" },
  { tk: "tsla", sym: "TSLA", name: "Tesla", tint: "#ff5a64", real: true, source: "Maker-provided" },
  { tk: "googl", sym: "GOOGL", name: "Alphabet", tint: "#8ab4f8", real: true, source: "Wikimedia Commons" },
];
const BY = new Map<string, BasePair>();
for (const p of BASE_PAIRS) { BY.set(p.tk, p); BY.set(p.sym.toLowerCase(), p); }
BY.set("weth", BY.get("eth")!); BY.set("musdg", BY.get("usdg")!);

/** Resolve a pair symbol ("mUSDG", "WETH", "STRATEGY"…) to a registered base pair, if any. */
export function basePair(sym?: string | null): BasePair | undefined {
  return sym ? BY.get(sym.toLowerCase()) : undefined;
}
export const pairLogo = (tk: string) => withBase(`/pairs/${tk}.png`);
export const pairCoin = (tk: string) => withBase(`/pairs/coin/${tk}.webp`);
export const pairCoinSm = (tk: string) => withBase(`/pairs/sm/${tk}.webp`);
export const PAIR_SKY = "/pair-art/sky.webp";
/** Placeholder new-coin squares (gritty monograms). */
export const SAMPLE_SQUARES = Array.from({ length: 24 }, (_, i) => `/pair-art/sq/m${String(i).padStart(2, "0")}.webp`);
export const SAYLOR_SQUARE = "/pair-art/sq/saylor.webp";

/** Deterministic SAMPLE art for rows that only know a ticker/token (profile holdings, etc.). */
export function sampleArtFor(key: string): { src: string; pair: string } {
  if (/^saylor$/i.test(key)) return { src: withBase(SAYLOR_SQUARE), pair: "STRATEGY" };
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return { src: withBase(SAMPLE_SQUARES[h % SAMPLE_SQUARES.length]), pair: BASE_PAIRS[(h >>> 8) % BASE_PAIRS.length].sym };
}

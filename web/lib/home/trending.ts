/**
 * App home: trending model (isomorphic, pure). Trending = highest 24h volume.
 * Inputs are the existing sources only: chain launches (lib/events listLaunches: name, pair, live mcap, graduated,
 * launch block) + the indexed trade fills (lib/server/trades → KV `trades:<coin>`, same data as /api/trades).
 * Nothing here is sampled or mocked: a stat that can't be derived is null and the UI hides it.
 */
import { BOMB_TIERS, TIERS } from "@/lib/config";
import { bombTierIndex } from "@/lib/flight/bombTier";
import { playerUsd, type Fill } from "@/lib/trades";

export const DAY_MS = 864e5;

export type TradeChip = {
  id: string;
  side: "buy" | "sell";
  usd: number;
  trader: string;
  ts: number;
  /** sells only: bomb tier (engine rule, lib/flight/bombTier) */
  bomb?: { k: (typeof BOMB_TIERS)[number]["k"]; name: string };
};

export type CoinStats = {
  /** $ volume over the last 24h (sum of fill notionals) */
  vol24: number;
  trades24: number;
  /** DUMPs in the last 24h: every sell drops a bomb (PUFF and up), same as the flight engine */
  bombs24: number;
  /** % change over 24h (live mcap vs the price at the 24h mark); null = not derivable */
  chg24: number | null;
  /** wallets holding a net-positive position from indexed BOOST/DUMP fills; null when the history is truncated */
  crew: number | null;
  lastTs: number | null;
};

export type HomeCoin = {
  token: string;
  name: string;
  ticker: string;
  pair: "STRATEGY" | "USDG" | "OTHER";
  pairSym: string;
  icon: string;
  creator: string;
  /** Full creator wallet (lower case), for the guild tag lookup. */
  creatorAddr?: string;
  mcapUsd: number;
  graduated: boolean;
  /** curve progressBps (tokens sold / curve supply, 1e4 = graduation) */
  progressBps?: number;
  /** launch block (newer = larger) */
  block: number;
  /** launch time, ms (filled for the hero + strip only) */
  launchedAt: number | null;
  stats: CoinStats | null;
};

export type HomeData = {
  at: number;
  /** newest first */
  coins: HomeCoin[];
  /** hero token (#1 trending, else the newest coin), null = empty state */
  hero: string | null;
  heroMode: "trending" | "newest" | "empty";
  /** #2 onward by 24h volume (volume > 0 only) */
  next: string[];
  /** latest fills of the hero, newest first */
  chips: TradeChip[];
};

/** Price before a fill, from the stored mid: usd = tokens × priceAfter × (pa+pb)/(2·pa) ⇒ pb/pa = 2·mid/priceAfter − 1. */
export function prePriceOf(f: Pick<Fill, "usd" | "tokens" | "priceUsd">): number | null {
  if (!(f.tokens > 0) || !(f.priceUsd > 0) || !(f.usd > 0)) return null;
  const r = (2 * (f.usd / f.tokens)) / f.priceUsd - 1;
  return r > 0 ? f.priceUsd * r : null;
}

/** Mcap before a fill (same basis as f.mcapUsd): pre-price × the fill's own supply (mcapUsd / priceUsd). */
export function preMcapOf(f: Pick<Fill, "usd" | "tokens" | "priceUsd" | "mcapUsd">): number | null {
  const pre = prePriceOf(f);
  return pre && f.mcapUsd > 0 && f.priceUsd > 0 ? pre * (f.mcapUsd / f.priceUsd) : null;
}

export function chipOf(f: Fill): TradeChip {
  const c: TradeChip = { id: f.id, side: f.side, usd: playerUsd(f) || f.usd, trader: f.trader, ts: f.ts };
  if (f.side === "sell") {
    const pre = prePriceOf(f);
    const pct = pre ? Math.abs(f.priceUsd / pre - 1) * 100 : 0;
    const t = BOMB_TIERS[bombTierIndex(pct)];
    c.bomb = { k: t.k, name: t.name };
  }
  return c;
}

/**
 * 24h stats from a coin's fills (any order). `mcapNow` = live chain mcap (listLaunches) for the change;
 * `truncated` = the fill list hit the read cap, so all-time aggregates (crew) are not trustworthy.
 */
export function statsFromFills(fills: Fill[], now: number, mcapNow: number, truncated = false): CoinStats {
  const cut = now - DAY_MS;
  const asc = [...fills].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  let vol24 = 0, trades24 = 0, bombs24 = 0;
  let ref: Fill | null = null;
  let firstIn: Fill | null = null;
  const pos = new Map<string, number>();
  for (const f of asc) {
    pos.set(f.trader, (pos.get(f.trader) ?? 0) + (f.side === "buy" ? f.tokens : -f.tokens));
    if (f.ts <= cut) { ref = f; continue; }
    if (!firstIn) firstIn = f;
    vol24 += playerUsd(f) || f.usd; trades24++;
    if (f.side === "sell") bombs24++;
  }
  // 24h change: live mcap vs the price at the 24h mark (last fill before it), or the pre-trade price of the first fill
  // when the coin is younger than 24h. Post-grad hook fills carry a frozen mcapAfterUsd (known FLOW bug) ⇒ no change.
  let chg24: number | null = null;
  // Compared as mcaps (lib/mcap basis, the coin's own supply on both sides): was live mcap ÷ a fixed supply vs a fill
  // price that already used the coin's own supply ⇒ wrong for any coin not launched with it (main #137).
  const refMcap = ref ? (ref.venue === "curve" ? ref.mcapUsd : null) : firstIn && firstIn.venue === "curve" ? preMcapOf(firstIn) : null;
  if (refMcap && mcapNow > 0 && (ref || firstIn)) chg24 = (mcapNow / refMcap - 1) * 100;
  if (chg24 != null && !Number.isFinite(chg24)) chg24 = null;
  let crew: number | null = null;
  if (!truncated && asc.length) { crew = 0; pos.forEach((v) => { if (v > 1) crew!++; }); }
  return { vol24, trades24, bombs24, chg24, crew, lastTs: asc.length ? asc[asc.length - 1].ts : null };
}

/** Coins with 24h volume, highest first (ties: more trades, then newer). */
export function rankTrending(coins: HomeCoin[]): HomeCoin[] {
  return coins
    .filter((c) => (c.stats?.vol24 ?? 0) > 0)
    .sort((a, b) => b.stats!.vol24 - a.stats!.vol24 || b.stats!.trades24 - a.stats!.trades24 || b.block - a.block);
}

/** Hero = #1 trending; no volume anywhere ⇒ the newest coin; no coins ⇒ empty. */
export function pickHero(coins: HomeCoin[]): Pick<HomeData, "hero" | "heroMode" | "next"> {
  const ranked = rankTrending(coins);
  if (ranked.length) return { hero: ranked[0].token, heroMode: "trending", next: ranked.slice(1, 9).map((c) => c.token) };
  const newest = [...coins].sort((a, b) => b.block - a.block)[0];
  return newest ? { hero: newest.token, heroMode: "newest", next: [] } : { hero: null, heroMode: "empty", next: [] };
}

/** "KÁRMÁN LINE" → "Kármán Line", "GATES OF HEAVEN" → "Gates of Heaven". */
export function tierTitle(name: string): string {
  return name.toLowerCase().split(" ").map((w, i) => (i > 0 && w === "of" ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

export type TierProgress = {
  index: number;
  name: string;
  title: string;
  /** 0..1 within the current tier band */
  progress: number;
  next: { index: number; title: string; lo: number } | null;
  /** $ of mcap (BOOST) left to the next tier */
  toNext: number | null;
};

export function tierProgress(mcap: number): TierProgress {
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (mcap >= TIERS[k].lo) i = k;
  const t = TIERS[i];
  const nx = i < TIERS.length - 1 ? TIERS[i + 1] : null;
  const lo = mcap < t.lo ? 0 : t.lo; // below Launch Pad: fill from 0
  const hi = nx ? nx.lo : t.hi;
  const progress = Math.max(0, Math.min(1, (mcap - lo) / (hi - lo)));
  return {
    index: i, name: t.name, title: tierTitle(t.name), progress,
    next: nx ? { index: i + 1, title: tierTitle(nx.name), lo: nx.lo } : null,
    toNext: nx ? Math.max(0, nx.lo - mcap) : null,
  };
}

/** Sky plate (one WebP per tier, ~100–170 KB, public/home/sky) + thumbnail. */
export const skySrc = (tier: number) => `/home/sky/t${Math.max(0, Math.min(17, tier))}.webp`;
export const thumbSrc = (tier: number) => `/home/thumb/t${Math.max(0, Math.min(17, tier))}.webp`;
/** Site rocket sprite (the Rocket Factory / hangar base, also lib/decal BASE_ROCKET_HI_SRC). 221×609. */
export const ROCKET_SRC = "/assets/rocket-hi.webp";

export function fmtAgeShort(ms: number): string {
  const m = ms / 6e4;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)}d`;
  return `${Math.round(d / 30)}mo`;
}

export const shortAddr = (a: string) => (a ? a.slice(0, 5) + "…" + a.slice(-3) : "");

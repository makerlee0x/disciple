/**
 * iPhone app home (components/app/AppHome, concept C) lists, pure so scripts/test-app-home.mts can check them:
 * the Flying now shelf and the Live rockets sheet (search + four sorts). Real launches from HomeData only.
 */
import { climbingNow, rankTrending, type HomeCoin } from "./trending";

/** Flying now: today's climbers first, then the rest by volume, then the newest; still on the curve only. */
export function flyingNow(coins: HomeCoin[], n = 8): HomeCoin[] {
  const live = coins.filter((c) => !c.graduated);
  const out: HomeCoin[] = [];
  const add = (c: HomeCoin) => { if (out.length < n && !out.some((x) => x.token === c.token)) out.push(c); };
  climbingNow(live, n).forEach(add);
  rankTrending(live).forEach(add);
  [...live].sort((a, b) => b.block - a.block).forEach(add);
  return out;
}

export type RocketSort = "trend" | "new" | "orbit" | "crew";
export const ROCKET_SORTS: readonly { k: RocketSort; label: string }[] = [
  { k: "trend", label: "Trending" },
  { k: "new", label: "New" },
  { k: "orbit", label: "Near orbit" },
  { k: "crew", label: "Biggest crew" },
];

/** The sheet's list for a query and sort (pure, for tests). Trending puts traded rockets first, then the newest. */
export function liveRockets(coins: HomeCoin[], q: string, sort: RocketSort): HomeCoin[] {
  const needle = q.trim().toLowerCase().replace(/^\$/, "");
  const hit = needle ? coins.filter((c) => c.name.toLowerCase().includes(needle) || c.ticker.toLowerCase().includes(needle)) : coins;
  const newest = (a: HomeCoin, b: HomeCoin) => b.block - a.block;
  if (sort === "new") return [...hit].sort(newest);
  if (sort === "orbit") return hit.filter((c) => !c.graduated).sort((a, b) => (b.progressBps ?? 0) - (a.progressBps ?? 0) || newest(a, b));
  if (sort === "crew") return [...hit].sort((a, b) => (b.stats?.crew ?? 0) - (a.stats?.crew ?? 0) || newest(a, b));
  const ranked = rankTrending(hit);
  const seen = new Set(ranked.map((c) => c.token));
  return [...ranked, ...hit.filter((c) => !seen.has(c.token)).sort(newest)];
}


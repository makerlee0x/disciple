/**
 * Launchpad list model. Rockets come from chain (Launched events). The deterministic sample generator for
 * exercising scale lives in lib/mock/launchpad.ts and only loads in `next dev` with ?sample=1 (lib/devSample).
 */
import type { RocketStats } from "./config";

export type PairKey = "STRATEGY" | "USDG" | "OTHER";

export type Rocket = {
  id: string;
  name: string;
  tk: string;
  live?: boolean;
  mcap: number | null;
  chg: number | null;
  c: string;
  icon?: string;
  hidden?: boolean;
  /** Quote pair bucket + display symbol (e.g. "mUSDG"). */
  pair?: PairKey;
  pairSym?: string;
  creator?: string;
  /** Full creator wallet on live coins only (the guild tag lookup). Sample rockets never set it. */
  creatorAddr?: string;
  graduated?: boolean;
  /** Live curve progressBps (tokensSold·1e4/sCurve, 10000 once graduated); drives the card progress bar. */
  progressBps?: number;
  /** Deterministic sparkline seed (dev sample rows only); live rockets without history render flat. */
  seed?: number;
  /** Launch order (higher = newer). */
  born?: number;
  stats: Omit<RocketStats, "mcapUsd">;
  /** Manual yes/no verification flag (e.g. set by a future admin API). isVerified() also checks VERIFIED_COINS. */
  verified?: boolean;
};

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Sparkline points (0..1) — deterministic per seed, trending toward chg. */
export function sparkPoints(seed: number | undefined, chg: number | null, n = 24): number[] {
  if (seed == null) return Array(n).fill(0.5);
  const r = rng(seed);
  const pts: number[] = [];
  let v = 0;
  const drift = (chg ?? 0) / 100 / n;
  for (let i = 0; i < n; i++) { v += drift + (r() - 0.5) * 0.08; pts.push(v); }
  const lo = Math.min(...pts), hi = Math.max(...pts), d = hi - lo || 1;
  return pts.map((p) => (p - lo) / d);
}

export function fmtAge(h: number): string {
  if (h < 1) return "new";
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  return `${Math.round(d / 30)}mo`;
}

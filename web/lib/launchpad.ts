/**
 * Launchpad list model + SAMPLE generator.
 * SAMPLE coins are deterministic mock data for exercising scale (500+ rows); they are always
 * labelled SAMPLE in the UI. LIVE rockets come from chain (Launched events) / the AI demo pool.
 */
import { CURVE, type RocketStats } from "./config";
import { BASE_PAIRS, SAMPLE_SQUARES } from "./pairArt";

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
  graduated?: boolean;
  /** Deterministic sparkline seed (SAMPLE) — live rockets without history render flat. */
  seed?: number;
  /** Launch order (higher = newer). */
  born?: number;
  stats: Omit<RocketStats, "mcapUsd">;
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const A = ["Halo", "Limbo", "Seraph", "Pearly", "Choir", "Psalm", "Manna", "Exodus", "Zion", "Gospel", "Ember", "Vesper", "Relic", "Abbey", "Orbit", "Nimbus", "Cherub", "Lantern", "Chalice", "Comet", "Glory", "Saint", "Hymn", "Covenant", "Ark", "Lumen", "Aether", "Rapture"];
const B = ["Dog", "Cat", "Frog", "Inu", "Ape", "Owl", "Lamb", "Dove", "Coin", "Moon", "Rocket", "Bird", "Whale", "Bear", "Fox", "Goat", "Toad", "Crab", "Duck", "Pig"];
const ICONS = ["/test-icons/wide.png", "/test-icons/transparent.png", "/assets/tier4.png", ...SAMPLE_SQUARES];
/** SAMPLE base-pair spread: STRATEGY + USDG heavier, the rest even. */
const PAIR_W = BASE_PAIRS.map((p) => (p.tk === "strategy" ? 5 : p.tk === "usdg" ? 3 : p.tk === "eth" ? 2 : 1));
const PAIR_SUM = PAIR_W.reduce((a, b) => a + b, 0);
function pickPair(x: number) {
  let t = x * PAIR_SUM;
  for (let i = 0; i < BASE_PAIRS.length; i++) { t -= PAIR_W[i]; if (t < 0) return BASE_PAIRS[i]; }
  return BASE_PAIRS[0];
}
const TINTS = ["#ffd0e0", "#e3d6ff", "#c9f5df", "#cfe0ff", "#E8EAEE", "#C9CED6"];
const CREW = ["SlowNeonThrush", "MerryPearlShark", "SecretMintLemur", "CandidSilverMoose", "GildedQuietOwl", "BraveIvoryFinch", "HushedAmberYak"];

/** N deterministic SAMPLE rockets (same output on server and client → no hydration drift). */
export function sampleRockets(n: number, withBase: (p: string) => string): Rocket[] {
  const r = rng(0xd15c1e);
  const out: Rocket[] = [];
  for (let i = 0; i < n; i++) {
    const name = `${A[Math.floor(r() * A.length)]} ${B[Math.floor(r() * B.length)]}`;
    const tk = (name.replace(/[^A-Za-z]/g, "").slice(0, 3) + name.split(" ")[1].slice(0, 2)).toUpperCase().slice(0, 5) + (i % 7 === 0 ? String(i % 10) : "");
    const grad = r() < 0.08;
    const mcap = grad ? CURVE.graduationMcap * (1 + r() * 60) : CURVE.startMcap + r() ** 1.6 * (CURVE.graduationMcap - CURVE.startMcap);
    const pr = r();
    const bp = pickPair(pr);
    const pair: PairKey = bp.tk === "strategy" ? "STRATEGY" : bp.tk === "usdg" ? "USDG" : "OTHER";
    const icon = ICONS[Math.floor(r() * ICONS.length)];
    const ageHours = Math.round(r() ** 2 * 24 * 90) + 1;
    out.push({
      id: `sample-${i.toString(16).padStart(4, "0")}`,
      name, tk,
      icon: icon ? withBase(icon) : undefined,
      mcap,
      chg: Math.round((r() - 0.42) * 900) / 10,
      c: TINTS[i % TINTS.length],
      pair, pairSym: bp.sym,
      creator: CREW[Math.floor(r() * CREW.length)],
      graduated: grad,
      seed: Math.floor(r() * 1e9),
      born: -ageHours,
      stats: {
        volume24hUsd: Math.round(r() ** 2 * 60_000),
        ageHours,
        holders: Math.round(5 + r() ** 2 * 900),
        liquidityUsd: Math.round(mcap * (0.05 + r() * 0.2)),
      },
    });
  }
  return out;
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

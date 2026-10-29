/**
 * DEV-ONLY sample rockets for exercising the launchpad at scale (500+ rows).
 * Imported only behind `devSample()` (NODE_ENV === "development" + ?sample=1), so it never ships in a production build.
 */
import { CURVE } from "@/lib/config";
import { BASE_PAIRS, SAMPLE_SQUARES } from "@/lib/pairArt";
import { rng, type PairKey, type Rocket } from "@/lib/launchpad";

const A = ["Halo", "Limbo", "Seraph", "Pearly", "Choir", "Psalm", "Manna", "Exodus", "Zion", "Gospel", "Ember", "Vesper", "Relic", "Abbey", "Orbit", "Nimbus", "Cherub", "Lantern", "Chalice", "Comet", "Glory", "Saint", "Hymn", "Covenant", "Ark", "Lumen", "Aether", "Rapture"];
const B = ["Dog", "Cat", "Frog", "Inu", "Ape", "Owl", "Lamb", "Dove", "Coin", "Moon", "Rocket", "Bird", "Whale", "Bear", "Fox", "Goat", "Toad", "Crab", "Duck", "Pig"];
// SAMPLE icons (tier4 as WebP: the same plate, 197 KB instead of the 852 KB PNG)
const ICONS = ["/test-icons/wide.png", "/test-icons/transparent.png", "/assets/tier4.webp", ...SAMPLE_SQUARES];
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


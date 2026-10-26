/**
 * Deterministic seeded mock trade histories for profile demo personas.
 * Clearly labeled SAMPLE DATA — not live indexer output.
 */
import type { Address } from "../protocol";
import type { StatsTrade } from "../stats";
import { computeStats, type PlayerStats } from "../stats";
import { deriveIdentity } from "../identity";
import { evaluateAchievements, topBadgesFromAchievements } from "../achievements";

export type PersonaId = "believer" | "trencher" | "bomber";

export interface PersonaMeta {
  id: PersonaId; handle: string; label: string; blurb: string; points: number;
  leaderboardRank: number; leaderboardSize: number; firstPlacePoints: number;
  sizePercentile: number; roiPercentile: number; showcaseIcon: string | null;
}

export const PERSONAS: Record<PersonaId, PersonaMeta> = {
  believer: {
    id: "believer", handle: "@halo_holder", label: "Believer",
    blurb: "Diamond-adjacent. Long holds, crew climbs, few bombs.",
    points: 12_400, leaderboardRank: 42, leaderboardSize: 2400, firstPlacePoints: 28_900,
    sizePercentile: 0.72, roiPercentile: 0.81, showcaseIcon: null,
  },
  trencher: {
    id: "trencher", handle: "@block0_ape", label: "Trencher",
    blurb: "Snipes launches, flips in minutes, lives in the trenches.",
    points: 6_800, leaderboardRank: 180, leaderboardSize: 2400, firstPlacePoints: 28_900,
    sizePercentile: 0.45, roiPercentile: 0.55, showcaseIcon: null,
  },
  bomber: {
    id: "bomber", handle: "@atom_choir", label: "Bomber",
    blurb: "BOOSTs just enough, then drops bunker → nuke payloads.",
    points: 9_200, leaderboardRank: 88, leaderboardSize: 2400, firstPlacePoints: 28_900,
    sizePercentile: 0.88, roiPercentile: 0.62, showcaseIcon: null,
  },
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addr(n: number): Address {
  return (`0x${n.toString(16).padStart(40, "0")}`) as Address;
}

const ROCKETS = [
  { ticker: "HALO", name: "Halo Ascent", token: addr(0xa1) },
  { ticker: "CHERUB", name: "Cherub Coil", token: addr(0xa2) },
  { ticker: "GATES", name: "Pearly Gate", token: addr(0xa3) },
  { ticker: "SERAPH", name: "Seraphim Six", token: addr(0xa4) },
  { ticker: "LIMBO", name: "Limbo Loop", token: addr(0xa5) },
  { ticker: "FIRM", name: "Firmament", token: addr(0xa6) },
  { ticker: "NUKE", name: "Nuke Nest", token: addr(0xa7) },
  { ticker: "TRENCH", name: "Trench Coin", token: addr(0xa8) },
  { ticker: "APE", name: "Ape Ascend", token: addr(0xa9) },
  { ticker: "JEET", name: "Jeet Jet", token: addr(0xaa) },
  { ticker: "WING", name: "Wing Wallet", token: addr(0xab) },
  { ticker: "PSALM", name: "Psalm Pump", token: addr(0xac) },
  { ticker: "HOST", name: "Heavenly Host", token: addr(0xad) },
  { ticker: "STAR", name: "Morning Star", token: addr(0xae) },
  { ticker: "DOME", name: "Dome Dominion", token: addr(0xaf) },
  { ticker: "ATOM", name: "Atom Amen", token: addr(0xb0) },
  { ticker: "CREW", name: "Crew Creed", token: addr(0xb1) },
  { ticker: "PAD", name: "Launch Pad X", token: addr(0xb2) },
];

const NOW = Date.UTC(2026, 9, 15, 18, 0, 0);

function price(mcap: number) { return mcap / 1_000_000; }

function push(
  out: StatsTrade[], r: (typeof ROCKETS)[0], side: "buy" | "sell", usd: number,
  mcap: number, impactBps: number, ts: number, launchTs: number, extra: Partial<StatsTrade> = {},
) {
  const after = side === "buy" ? mcap * (1 + impactBps / 20000) : mcap * (1 - impactBps / 10000);
  out.push({
    token: r.token, ticker: r.ticker, name: r.name, side, usd,
    priceBefore: price(mcap), priceAfter: price(after), impactBps, mcapAfter: after,
    ts, launchTs, peakMcap: Math.max(mcap, after, extra.peakMcap ?? 0), ...extra,
  });
}

function believer(rand: () => number): StatsTrade[] {
  const out: StatsTrade[] = [];
  const picks = [ROCKETS[0], ROCKETS[2], ROCKETS[5], ROCKETS[11], ROCKETS[16]];
  picks.forEach((r, i) => {
    const launch = NOW - (45 - i * 8) * 864e5;
    let mcap = 8_000 + rand() * 3_000;
    push(out, r, "buy", 120 + rand() * 180, mcap, 40, launch + 4 * 3.6e6, launch, {
      assistedGraduation: i < 3, graduated: i < 3, topFuelerAtGrad: i === 0,
    });
    mcap = 18_000 + rand() * 8_000;
    push(out, r, "buy", 200 + rand() * 150, mcap, 35, launch + 2 * 864e5, launch, {
      assistedGraduation: i < 3, graduated: i < 3, topFuelerAtGrad: i === 0, peakMcap: i === 0 ? 150_000 : mcap,
    });
    mcap = i < 3 ? 36_000 + rand() * 25_000 : 24_000;
    push(out, r, "buy", 90 + rand() * 80, mcap, 25, launch + 6 * 864e5, launch, {
      graduated: i < 3, assistedGraduation: i < 3, topFuelerAtGrad: i === 0, peakMcap: i === 0 ? 180_000 : mcap * 1.2,
    });
    // hold through drawdown on HALO
    if (i === 0) {
      push(out, r, "buy", 250, 70_000, 20, launch + 14 * 864e5, launch, { graduated: true, peakMcap: 180_000, topFuelerAtGrad: true });
      // Drawdown to ~40% of peak while still holding (Diamond Hands / Believer)
      push(out, r, "sell", 5, 28_000, 40, launch + 16 * 864e5, launch, { graduated: true, peakMcap: 180_000, topFuelerAtGrad: true });
      push(out, r, "buy", 40, 32_000, 15, launch + 18 * 864e5, launch, { graduated: true, peakMcap: 180_000, topFuelerAtGrad: true });
      // leave open — no full exit
    } else if (i < 3) {
      push(out, r, "sell", 70, mcap * 1.15, 100, launch + 12 * 864e5, launch, { graduated: true, peakMcap: mcap * 1.3 });
    } else {
      push(out, r, "sell", 100, mcap * 0.7, 150, launch + 10 * 864e5, launch, { peakMcap: mcap });
    }
  });
  return out;
}

function trencher(rand: () => number): StatsTrade[] {
  const out: StatsTrade[] = [];
  ROCKETS.forEach((r, i) => {
    const launch = NOW - (22 - (i % 18)) * 864e5;
    const t0 = launch + 8_000 + rand() * 100_000;
    const mcap = 7_500 + rand() * 4_000;
    push(out, r, "buy", 30 + rand() * 50, mcap, 90, t0, launch);
    const hold = (0.5 + rand() * 3) * 60_000;
    const up = rand() > 0.42;
    const exit = up ? mcap * (1.08 + rand() * 0.4) : mcap * (0.72 + rand() * 0.2);
    push(out, r, "sell", 200, exit, 80 + rand() * 90, t0 + hold, launch); // impact < grenade, full exit
    if (rand() > 0.5) {
      const t1 = t0 + hold + 90_000;
      push(out, r, "buy", 22 + rand() * 30, exit * 1.01, 70, t1, launch);
      push(out, r, "sell", 200, exit * (0.85 + rand() * 0.35), 90, t1 + 40_000, launch);
    }
  });
  for (let k = 0; k < 14; k++) {
    const r = { ticker: `TR${k}`, name: `Trench ${k}`, token: addr(0xc00 + k) };
    const launch = NOW - (2 + k) * 864e5;
    const t0 = launch + 15_000 + rand() * 50_000;
    push(out, r, "buy", 18 + rand() * 22, 8_200, 55, t0, launch);
    push(out, r, "sell", 120, 8_200 * (0.88 + rand() * 0.3), 90, t0 + 30_000, launch);
  }
  return out;
}

function bomber(rand: () => number): StatsTrade[] {
  const out: StatsTrade[] = [];
  const picks = [ROCKETS[6], ROCKETS[9], ROCKETS[15], ROCKETS[3], ROCKETS[12], ROCKETS[7], ROCKETS[10], ROCKETS[14]];
  const impacts = [250, 520, 1300, 2600, 5200, 800, 400, 2800];
  picks.forEach((r, i) => {
    const launch = NOW - (28 - i * 3) * 864e5;
    let mcap = 12_000 + rand() * 10_000;
    push(out, r, "buy", 250 + rand() * 350, mcap, 55, launch + 20 * 60_000, launch);
    mcap = 28_000 + rand() * 40_000;
    push(out, r, "buy", 180 + rand() * 220, mcap, 45, launch + 864e5, launch, { peakMcap: mcap * 1.3 });
    mcap = 55_000 + rand() * 90_000;
    push(out, r, "sell", 400 + rand() * 500, mcap, impacts[i], launch + 2.5 * 864e5, launch, { peakMcap: mcap });
    if (i < 5) {
      push(out, r, "buy", 120, mcap * 0.65, 40, launch + 4 * 864e5, launch);
      push(out, r, "sell", 200, mcap * 0.9, impacts[Math.min(i + 1, impacts.length - 1)], launch + 4.4 * 864e5, launch, { peakMcap: mcap });
    }
  });
  const nukeR = ROCKETS[15];
  const launch = NOW - 9 * 864e5;
  push(out, nukeR, "buy", 900, 48_000, 40, launch + 3.6e6, launch);
  push(out, nukeR, "sell", 850, 95_000, 5100, launch + 2 * 864e5, launch, { peakMcap: 110_000 });
  push(out, nukeR, "buy", 500, 42_000, 30, launch + 3 * 864e5, launch);
  push(out, nukeR, "sell", 480, 75_000, 2700, launch + 3.6 * 864e5, launch, { peakMcap: 110_000 });
  return out;
}

export function sampleTrades(persona: PersonaId): StatsTrade[] {
  const seed = persona === "believer" ? 0xbe11e7 : persona === "trencher" ? 0x72e11c : 0xb0bb42;
  const rand = rng(seed);
  if (persona === "believer") return believer(rand);
  if (persona === "trencher") return trencher(rand);
  return bomber(rand);
}

export type PersonaBundle = PlayerStats & {
  identity: ReturnType<typeof deriveIdentity>;
  achievements: ReturnType<typeof evaluateAchievements>;
};

export function buildPersonaStats(persona: PersonaId): PersonaBundle {
  const meta = PERSONAS[persona];
  const stats = computeStats(sampleTrades(persona), {
    handle: meta.handle, persona: meta.label, points: meta.points,
    leaderboardRank: meta.leaderboardRank, leaderboardSize: meta.leaderboardSize,
    firstPlacePoints: meta.firstPlacePoints, now: NOW, showcaseIcon: meta.showcaseIcon,
    sizePercentile: meta.sizePercentile, roiPercentile: meta.roiPercentile,
  });
  const achievements = evaluateAchievements(stats);
  stats.topBadges = topBadgesFromAchievements(achievements, 3);
  return { ...stats, identity: deriveIdentity(stats.metrics), achievements };
}

export const SAMPLE_DATA_LABEL = "SAMPLE DATA — seeded mock trade history (not live)";

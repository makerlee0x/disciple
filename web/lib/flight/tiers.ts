/**
 * SINGLE SOURCE OF TRUTH for the flight tier ladder (DISCIPLE constitution, contracts Constants.sol lows).
 * engine.js and replay.js embed a GENERATED copy of this list (scripts/gen-flight-data.mjs, between the
 * @gen:flight-data markers). Edit here, then `npm run gen:flight`; `npm run test:flightdata` fails on drift.
 * Half-open bands [lo, hi). Start $3,333 → graduation (OUTER SPACE) $33,333. `sky` = background asset path (prefix the base path).
 */
export type FlightTier = { name: string; lo: number; hi: number; bg: string; sky: string };

export const FLIGHT_TIERS: FlightTier[] = [
  { name: "LAUNCH PAD", lo: 3_333, hi: 12e3, bg: "tier0", sky: "/assets/tier0.webp" },
  { name: "OZONE", lo: 12e3, hi: 18e3, bg: "tier1", sky: "/assets/tier1.webp" },
  { name: "STRATOSPHERE", lo: 18e3, hi: 25e3, bg: "tier2", sky: "/assets/tier2.webp" },
  { name: "KÁRMÁN LINE", lo: 25e3, hi: 33_333, bg: "tier3", sky: "/assets/tier3.webp" },
  { name: "OUTER SPACE", lo: 33_333, hi: 55e3, bg: "tier4", sky: "/assets/tier4.webp" },
  { name: "FIRMAMENT", lo: 55e3, hi: 100e3, bg: "tier5", sky: "/assets/tier5.webp" },
  { name: "MORNING STARS", lo: 100e3, hi: 333e3, bg: "tier6", sky: "/assets/tier6.webp" },
  { name: "HEAVENLY HOST", lo: 333e3, hi: 777e3, bg: "tier7", sky: "/assets/tier7.webp" },
  { name: "THE MOON", lo: 777e3, hi: 1.2e6, bg: "tier8", sky: "/assets/tier8.webp" },
  { name: "URANUS", lo: 1.2e6, hi: 3.3e6, bg: "tier9", sky: "/assets/tier9.webp" },
  { name: "LIMBO", lo: 3.3e6, hi: 7.7e6, bg: "tier10", sky: "/assets/tier10.webp" },
  { name: "GATES OF HEAVEN", lo: 7.7e6, hi: 33e6, bg: "tier11", sky: "/assets/tier11.webp" },
  { name: "THRONE ROOM", lo: 33e6, hi: 77e6, bg: "tier12", sky: "/assets/tier12.webp" },
  { name: "CHERUBIM", lo: 77e6, hi: 120e6, bg: "tier13", sky: "/assets/tier13.webp" },
  { name: "SERAPHIM", lo: 120e6, hi: 777e6, bg: "tier14", sky: "/assets/tier14.webp" },
  { name: "AETHER", lo: 777e6, hi: 1.2e9, bg: "tier15", sky: "/assets/tier15.webp" },
  { name: "EMPYREAN", lo: 1.2e9, hi: 3.3e9, bg: "tier16", sky: "/assets/tier16.webp" },
  { name: "SEVENTH HEAVEN", lo: 3.3e9, hi: 7.77e9, bg: "tier17", sky: "/assets/tier17.webp" },
];

/** Index of the tier containing mcap (below $3,333 → 0; above the top → last). */
export function tierIndexAt(mcap: number): number {
  let i = 0; while (i < FLIGHT_TIERS.length - 1 && mcap >= FLIGHT_TIERS[i + 1].lo) i++; return i;
}
export const tierAt = (mcap: number): FlightTier => FLIGHT_TIERS[tierIndexAt(mcap)];

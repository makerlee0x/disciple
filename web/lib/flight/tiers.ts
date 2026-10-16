/**
 * SINGLE SOURCE OF TRUTH for the flight tier ladder (DISCIPLE constitution, contracts Constants.sol lows).
 * engine.js and replay.js embed a GENERATED copy of this list (scripts/gen-flight-data.mjs, between the
 * @gen:flight-data markers). Edit here, then `npm run gen:flight`; `npm run test:flightdata` fails on drift.
 * Half-open bands [lo, hi). Start $7K → graduation (PEARLY GATES) $33K. `sky` = background asset path (prefix the base path).
 */
export type FlightTier = { name: string; lo: number; hi: number; bg: string; sky: string };

export const FLIGHT_TIERS: FlightTier[] = [
  { name: "LAUNCH PAD", lo: 7e3, hi: 12e3, bg: "tier0", sky: "/assets/tier0.png" },
  { name: "LIMBO", lo: 12e3, hi: 18e3, bg: "tier1", sky: "/assets/tier1.png" },
  { name: "ASCENSION", lo: 18e3, hi: 25e3, bg: "tier2", sky: "/assets/tier2.png" },
  { name: "NARROW GATE", lo: 25e3, hi: 33e3, bg: "tier3", sky: "/assets/tier3.png" },
  { name: "PEARLY GATES", lo: 33e3, hi: 55e3, bg: "tier4", sky: "/assets/tier4.png" },
  { name: "FIRMAMENT", lo: 55e3, hi: 100e3, bg: "tier5", sky: "/assets/tier5.png" },
  { name: "ANGELS", lo: 100e3, hi: 333e3, bg: "tier6", sky: "/assets/tier6.png" },
  { name: "ARCHANGELS", lo: 333e3, hi: 777e3, bg: "tier7", sky: "/assets/tier7.png" },
  { name: "HEAVENLY HOST", lo: 777e3, hi: 1.2e6, bg: "tier8", sky: "/assets/tier8.png" },
  { name: "MORNING STARS", lo: 1.2e6, hi: 3.3e6, bg: "tier9", sky: "/assets/tier9.png" },
  { name: "VIRTUES", lo: 3.3e6, hi: 7.7e6, bg: "tier0", sky: "/assets/tier0.png" },
  { name: "DOMINIONS", lo: 7.7e6, hi: 33e6, bg: "tier1", sky: "/assets/tier1.png" },
  { name: "THRONE ROOM", lo: 33e6, hi: 77e6, bg: "tier2", sky: "/assets/tier2.png" },
  { name: "CHERUBIM", lo: 77e6, hi: 120e6, bg: "tier3", sky: "/assets/tier3.png" },
  { name: "SERAPHIM", lo: 120e6, hi: 777e6, bg: "tier4", sky: "/assets/tier4.png" },
  { name: "AETHER", lo: 777e6, hi: 1.2e9, bg: "tier5", sky: "/assets/tier5.png" },
  { name: "EMPYREAN", lo: 1.2e9, hi: 3.3e9, bg: "tier6", sky: "/assets/tier6.png" },
  { name: "SEVENTH HEAVEN", lo: 3.3e9, hi: 7.77e9, bg: "tier7", sky: "/assets/tier7.png" },
];

/** Index of the tier containing mcap (below $7K → 0; above the top → last). */
export function tierIndexAt(mcap: number): number {
  let i = 0; while (i < FLIGHT_TIERS.length - 1 && mcap >= FLIGHT_TIERS[i + 1].lo) i++; return i;
}
export const tierAt = (mcap: number): FlightTier => FLIGHT_TIERS[tierIndexAt(mcap)];

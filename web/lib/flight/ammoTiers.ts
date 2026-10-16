/**
 * AMMO TIERS — the one place ammo/bomb preset $ sizes are defined per rocket mcap tier.
 * Documented in docs/ammo-tiers.md. The flight engine receives this table as window.__AMMO_TIERS
 * (set by FlightCanvas before engine.js loads) and re-labels its six presets (FEATHER…GLORY) from it.
 *
 * Rule of thumb: each step is ≈4–5× the previous tier, so a preset is a similar % of mcap across tiers.
 * Floors stay at the network min shot (~$0.20 on RH) so small-budget players can still play low-mcap rockets.
 * Sells (bombs) use the same presets; bomb *tiers* are by % price impact (BOMB_PCT) and need no scaling.
 */
export type AmmoTier = {
  id: string;
  name: string;
  /** exclusive upper bound in $ mcap; null = open-ended top tier */
  maxMcap: number | null;
  /** $ per shot for FEATHER, EMBER, FLARE, COMET, ARCHANGEL, GLORY */
  usd: [number, number, number, number, number, number];
};

export const AMMO_TIERS: AmmoTier[] = [
  { id: "spark",     name: "SPARK",     maxMcap: 50_000,     usd: [0.2, 0.5, 1, 2, 5, 20] },
  { id: "kindle",    name: "KINDLE",    maxMcap: 250_000,    usd: [0.5, 2, 5, 10, 25, 100] },
  { id: "blaze",     name: "BLAZE",     maxMcap: 1_000_000,  usd: [2, 5, 20, 50, 100, 500] },
  { id: "inferno",   name: "INFERNO",   maxMcap: 5_000_000,  usd: [5, 25, 100, 250, 500, 2_500] },
  { id: "nova",      name: "NOVA",      maxMcap: 20_000_000, usd: [25, 100, 500, 1_000, 2_500, 10_000] },
  { id: "supernova", name: "SUPERNOVA", maxMcap: null,       usd: [100, 500, 2_000, 5_000, 10_000, 50_000] },
];

/** Hysteresis: the rocket must be this factor past a boundary before its tier changes (no flapping). */
export const AMMO_TIER_HYSTERESIS = 1.05;

export function ammoTierOf(mcap: number): number {
  for (let i = 0; i < AMMO_TIERS.length; i++) {
    const m = AMMO_TIERS[i].maxMcap;
    if (m == null || mcap < m) return i;
  }
  return AMMO_TIERS.length - 1;
}

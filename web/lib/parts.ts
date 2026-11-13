/**
 * Rocket Factory parts catalogue: one list for the shop UI (held for v2) and the server purchase
 * (POST /api/shop/buy). Prices are in XP. Parts are cosmetic only: they never change price, fills or odds.
 * `minPrestige` locks the rarest parts until a pilot has prestiged that many times.
 */
import { COINS, SKINS, THRUSTERS } from "./rocketSkin";

export type Slot = "body" | "thrusters" | "coin" | "trail" | "frame";
export type PartStats = { thrust: number; handling: number; glow: number; aura: number; launch: number };
export interface Part { id: string; slot: Slot; ref: string; name: string; cost: number; tint: string; stats: Partial<PartStats>; minPrestige?: number }

const SKIN_COST: Record<string, [number, Partial<PartStats>, number?]> = {
  chrome: [0, {}], gold: [2500, { glow: 1.6, aura: 1.2 }, 1], rose: [1800, { aura: 1.4 }], green: [1500, { handling: 1.0, glow: 0.6 }],
  cobalt: [1500, { handling: 1.2 }], violet: [3000, { aura: 2.0, glow: 0.8 }, 1], matte: [2200, { handling: 1.6, launch: 0.6 }], crimson: [2000, { thrust: 0.8, glow: 0.8 }],
};
const THR_COST: Record<string, [number, Partial<PartStats>, number?]> = {
  stock: [0, {}], seraph: [500, { thrust: 1.4, launch: 1.0 }], ion: [3000, { thrust: 2.4, launch: 1.8 }, 1],
  plasma: [2400, { thrust: 1.8, glow: 1.0 }], venom: [1600, { thrust: 1.2, handling: 0.8 }], inferno: [2800, { thrust: 2.2, launch: 1.2 }],
};
const COIN_COST: Record<string, [number, Partial<PartStats>, number?]> = {
  halo: [0, {}], sun: [900, { glow: 1.0 }], star: [1200, { aura: 1.0 }], moon: [1400, { aura: 1.2, glow: 0.4 }],
  diamond: [3500, { aura: 2.0, handling: 0.6 }, 2], frog: [700, { launch: 0.8 }],
};
const lock = (n?: number) => (n ? { minPrestige: n } : {});

export const PARTS: readonly Part[] = [
  ...SKINS.map((k) => ({ id: `body-${k.id}`, slot: "body" as Slot, ref: k.id, name: k.name, cost: SKIN_COST[k.id]?.[0] ?? 1000, tint: k.tint ?? "#c9d2e6", stats: SKIN_COST[k.id]?.[1] ?? {}, ...lock(SKIN_COST[k.id]?.[2]) })),
  ...THRUSTERS.map((t) => ({ id: `thr-${t.id}`, slot: "thrusters" as Slot, ref: t.id, name: t.name, cost: THR_COST[t.id]?.[0] ?? 1000, tint: t.flame, stats: THR_COST[t.id]?.[1] ?? {}, ...lock(THR_COST[t.id]?.[2]) })),
  ...COINS.map((c) => ({ id: `coin-${c.id}`, slot: "coin" as Slot, ref: c.id, name: c.name, cost: COIN_COST[c.id]?.[0] ?? 1000, tint: c.bg[1], stats: COIN_COST[c.id]?.[1] ?? {}, ...lock(COIN_COST[c.id]?.[2]) })),
  { id: "trail-none", slot: "trail", ref: "", name: "Clean Exhaust", cost: 0, tint: "#7d879f", stats: {} },
  { id: "trail-wing", slot: "trail", ref: "", name: "Wing Halo Trail", cost: 1000, tint: "#fff7df", stats: { glow: 1.2 } },
  { id: "trail-star", slot: "trail", ref: "", name: "Star Wake", cost: 1800, tint: "#c9b6f2", stats: { glow: 1.8, aura: 0.6 } },
  { id: "trail-gold", slot: "trail", ref: "", name: "Halo Gold", cost: 5000, tint: "#ffd060", stats: { glow: 2.6, aura: 1.2 }, minPrestige: 1 },
  { id: "frame-none", slot: "frame", ref: "", name: "No Frame", cost: 0, tint: "#7d879f", stats: {} },
  { id: "frame-pearly", slot: "frame", ref: "", name: "Pearly Frame", cost: 800, tint: "#E8EAEE", stats: { aura: 0.8 } },
  { id: "frame-winged", slot: "frame", ref: "", name: "Winged Border", cost: 2200, tint: "#ffe7a3", stats: { aura: 1.6 } },
];
export const partById = (id: string) => PARTS.find((p) => p.id === id);
/** Free parts every pilot owns. */
export const isFreePart = (p: Part) => p.cost === 0;

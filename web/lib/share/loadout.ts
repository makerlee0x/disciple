/** Rocket Factory loadout (localStorage disciple.rocket.loadout.v1) → share-scene Loadout. Cosmetic only. */
import { coinById, skinById, thrusterById, LOADOUT_KEY } from "@/lib/rocketSkin";
import type { Loadout } from "./scene";

export interface LoadoutIds { skin: string; coin: string; thruster: string }
export const DEFAULT_IDS: LoadoutIds = { skin: "chrome", coin: "halo", thruster: "stock" };
export function loadoutFromIds(ids: Partial<LoadoutIds>): Loadout {
  return { skin: skinById(ids.skin || "chrome"), coin: coinById(ids.coin || "halo"), thruster: thrusterById(ids.thruster || "stock") };
}
/** Browser: read the equipped parts (ids like body-gold / thr-ion / coin-sun). */
export function localLoadoutIds(): LoadoutIds {
  try {
    const j = JSON.parse(localStorage.getItem(LOADOUT_KEY) || "{}") as { equipped?: Record<string, string> };
    const e = j.equipped || {};
    return { skin: (e.body || "").replace(/^body-/, "") || "chrome", coin: (e.coin || "").replace(/^coin-/, "") || "halo", thruster: (e.thrusters || "").replace(/^thr-/, "") || "stock" };
  } catch { return DEFAULT_IDS; }
}

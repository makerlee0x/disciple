/** Rocket Factory loadout (localStorage disciple.rocket.loadout.v1) → share-scene Loadout. Cosmetic only. */
import { coinById, skinById, thrusterById, LOADOUT_KEY } from "@/lib/rocketSkin";
import type { Loadout } from "./scene";

/** accessory / stats are optional and only present when stored (forward-compatible; the flight replay uses them for visuals only) */
export interface LoadoutIds { skin: string; coin: string; thruster: string; accessory?: string; stats?: Partial<Record<"thrust" | "glow" | "aura" | "launch" | "style" | "handling", number>> }
export const DEFAULT_IDS: LoadoutIds = { skin: "chrome", coin: "halo", thruster: "stock" };
export function loadoutFromIds(ids: Partial<LoadoutIds>): Loadout {
  return { skin: skinById(ids.skin || "chrome"), coin: coinById(ids.coin || "halo"), thruster: thrusterById(ids.thruster || "stock") };
}
/** Browser: read the equipped parts (ids like body-gold / thr-ion / coin-sun). */
export function localLoadoutIds(): LoadoutIds {
  try {
    const j = JSON.parse(localStorage.getItem(LOADOUT_KEY) || "{}") as { equipped?: Record<string, string>; stats?: LoadoutIds["stats"] };
    const e = j.equipped || {};
    const ids: LoadoutIds = { skin: (e.body || "").replace(/^body-/, "") || "chrome", coin: (e.coin || "").replace(/^coin-/, "") || "halo", thruster: (e.thrusters || "").replace(/^thr-/, "") || "stock" };
    if (typeof e.accessory === "string" && e.accessory) ids.accessory = e.accessory.replace(/^acc-/, "");
    if (j.stats && typeof j.stats === "object") ids.stats = j.stats;
    return ids;
  } catch { return DEFAULT_IDS; }
}

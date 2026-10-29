/**
 * Profile "loot" r1 = the cosmetic parts a pilot has earned: the skin / trail / frame rewards of their unlocked
 * achievements (lib/achievements). No equip, sealed drops or part stats yet (open questions for lee), so none are shown.
 */
import { rarityRank } from "./config";
import type { AchievementView } from "./achievements";

export type LootSlot = "skin" | "trail" | "frame";
export const LOOT_SLOTS: readonly LootSlot[] = ["skin", "trail", "frame"];
export interface LootPart { id: string; name: string; slot: LootSlot; rarity: string; from: AchievementView }

export function lootFromAchievements(views: AchievementView[]): LootPart[] {
  const out: LootPart[] = [];
  for (const a of views) {
    if (a.state !== "unlocked") continue;
    for (const slot of LOOT_SLOTS) {
      const name = a.reward[slot];
      if (name) out.push({ id: `${a.id}-${slot}`, name, slot, rarity: a.rarity, from: a });
    }
  }
  // Rarity high → low, then catalog order (stable).
  return out.sort((x, y) => rarityRank(y.rarity) - rarityRank(x.rarity));
}

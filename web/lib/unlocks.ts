/**
 * Rocket looks at launch (canvas board "Rocket variety at launch"). The item shop waits for v2: until then every hull is
 * the one chrome rocket recoloured in code (lib/hullRamp) and every flare is drawn in code, and pilots earn them by
 * playing, never by paying. Rules read only what the Hangar already has: level, prestige and trophies. Cosmetic only.
 */
import { MILESTONE_COPY, XP_PER_PRESTIGE, levelInfo, xpForLevel } from "./xp";
import { HULL_NAMES, REWARDS, itemById } from "./collection";

export type Rarity = "common" | "rare" | "epic" | "legendary";
export type Rule = { kind: "free" } | { kind: "level"; level: number } | { kind: "prestige"; prestige: number } | { kind: "trophy"; trophy: string };
export interface Look { id: string; name: string; rarity: Rarity; rule: Rule; swatch: string }

/** Hull ids are lib/rocketSkin SKINS ids. */
export const HULLS: readonly Look[] = [
  { id: "chrome", name: "Chrome", rarity: "common", rule: { kind: "free" }, swatch: "#C9D2E6" },
  { id: "matte", name: "Matte", rarity: "rare", rule: { kind: "level", level: 10 }, swatch: "#9AA0AC" },
  { id: "violet", name: "Violet", rarity: "epic", rule: { kind: "level", level: 25 }, swatch: "#9B6BFF" },
  { id: "gold", name: "Gold", rarity: "legendary", rule: { kind: "prestige", prestige: 1 }, swatch: "#F3C969" },
];
/** Flare ids are lib/rocketSkin THRUSTERS ids. */
export const FLARES: readonly Look[] = [
  { id: "stock", name: "Classic", rarity: "common", rule: { kind: "free" }, swatch: "#FFC56A" },
  { id: "ion", name: "Plasma", rarity: "rare", rule: { kind: "level", level: 5 }, swatch: "#7FD8FF" },
  { id: "venom", name: "Toxic", rarity: "epic", rule: { kind: "trophy", trophy: "through_pearly_gates" }, swatch: "#7CFF8A" },
  { id: "neon", name: "Neon", rarity: "legendary", rule: { kind: "trophy", trophy: "final_boost" }, swatch: "#FF5FB4" },
];

export interface Progress { level: number; prestige: number; trophies: ReadonlySet<string> }

/** A level unlock stays unlocked after a prestige resets the level. */
export function isUnlocked(r: Rule, p: Progress): boolean {
  switch (r.kind) {
    case "free": return true;
    case "level": return p.prestige > 0 || p.level >= r.level;
    case "prestige": return p.prestige >= r.prestige;
    case "trophy": return p.trophies.has(r.trophy);
  }
}

export function ruleLabel(r: Rule): string {
  switch (r.kind) {
    case "free": return "Every pilot starts here";
    case "level": return `Unlocks at level ${r.level}`;
    case "prestige": return `Reach Prestige ${r.prestige}`;
    case "trophy": return `Earn the ${MILESTONE_COPY[r.trophy]?.name ?? "matching"} trophy`;
  }
}

/** the next collection reward a level gives a pilot with `totalXp` (+ `extra` not yet saved): "80 more unlocks the Ice Wake trail" */
export function nextLevelUnlock(totalXp: number, prestige = 0, extra = 0): { name: string; part: "skin" | "trail"; level: number; more: number } | null {
  if (prestige > 0) return null;   // level rewards stay earned after a prestige
  const now = levelInfo(totalXp + extra, prestige).level;
  const next = REWARDS.map((r) => ({ r, it: itemById(r.item) }))
    .filter((x): x is { r: (typeof REWARDS)[number]; it: NonNullable<typeof x.it> } => !!x.it && x.r.rule.kind === "level" && x.r.rule.level > now)
    .sort((a, b) => (a.r.rule as { level: number }).level - (b.r.rule as { level: number }).level)[0];
  if (!next) return null;
  const level = (next.r.rule as { level: number }).level;
  const name = next.it.kind === "skin" ? `${HULL_NAMES[next.it.hull!]} ${next.it.name}` : next.it.name;
  return { name, part: next.it.kind === "skin" ? "skin" : "trail", level, more: Math.max(1, xpForLevel(level) - (totalXp + extra - prestige * XP_PER_PRESTIGE)) };
}

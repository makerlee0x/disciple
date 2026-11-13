/**
 * Rocket looks at launch (canvas board "Rocket variety at launch"). The item shop waits for v2: until then every hull is
 * the one chrome rocket recoloured in code (lib/hullRamp) and every flare is drawn in code, and pilots earn them by
 * playing, never by paying. Rules read only what the Hangar already has: level, prestige and trophies. Cosmetic only.
 */
import { MILESTONE_COPY, XP_PER_PRESTIGE, levelInfo, xpForLevel } from "./xp";

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

/** the next look a level unlocks for a pilot with `totalXp` (+ `extra` not yet saved): "80 more unlocks the Plasma flare" */
export function nextLevelUnlock(totalXp: number, prestige = 0, extra = 0): { name: string; part: "hull" | "flare"; level: number; more: number } | null {
  if (prestige > 0) return null;   // level unlocks stay unlocked after a prestige
  const now = levelInfo(totalXp + extra, prestige).level;
  const next = [...HULLS.map((l) => ({ l, part: "hull" as const })), ...FLARES.map((l) => ({ l, part: "flare" as const }))]
    .filter((x) => x.l.rule.kind === "level" && x.l.rule.level > now)
    .sort((a, b) => (a.l.rule as { level: number }).level - (b.l.rule as { level: number }).level)[0];
  if (!next) return null;
  const level = (next.l.rule as { level: number }).level;
  return { name: next.l.name, part: next.part, level, more: Math.max(1, xpForLevel(level) - (totalXp + extra - prestige * XP_PER_PRESTIGE)) };
}

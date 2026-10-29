/**
 * CoD-style prestige ladder: points → level (1..MAX_LEVEL) → prestige.
 * Replaces the old "season pass" framing. Pure function, no season reset.
 */
export const MAX_LEVEL = 50;
export const PRESTIGE_NAMES = [
  "Normie", "Acolyte", "Disciple", "Herald", "Angel", "Archangel", "Seraph", "Throne", "Dominion", "Empyrean",
] as const;

const xpForLevel = (lv: number) => 100 + lv * 40; // per-level requirement

export interface PrestigeProgress {
  prestige: number; prestigeName: string; level: number; maxLevel: number;
  into: number; need: number; progress: number; nextLabel: string;
}

export function prestigeFromPoints(points: number): PrestigeProgress {
  let p = Math.max(0, Math.floor(points));
  const perPrestige = Array.from({ length: MAX_LEVEL }, (_, i) => xpForLevel(i + 1)).reduce((a, b) => a + b, 0);
  const prestige = Math.min(PRESTIGE_NAMES.length - 1, Math.floor(p / perPrestige));
  p -= prestige * perPrestige;
  let level = 1;
  while (level < MAX_LEVEL && p >= xpForLevel(level)) { p -= xpForLevel(level); level++; }
  const need = xpForLevel(level);
  const into = Math.min(p, need);
  return {
    prestige, prestigeName: PRESTIGE_NAMES[prestige], level, maxLevel: MAX_LEVEL,
    into, need, progress: into / need,
    nextLabel: level >= MAX_LEVEL ? `Prestige ${prestige + 1} · ${PRESTIGE_NAMES[Math.min(prestige + 1, PRESTIGE_NAMES.length - 1)]}` : `Level ${level + 1}`,
  };
}

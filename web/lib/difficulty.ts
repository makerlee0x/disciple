/**
 * Launch difficulty as players see it (brand v3): the on-chain mode (lib/modeRules MODE) read as Easy, Hard or Expert,
 * and "In orbit" once the rocket graduates (the mode caps switch off on the pool). Badge colours: .dsc3-badge-<key>.
 */
import { MODE } from "./modeRules";

export type DifficultyKey = "easy" | "hard" | "expert" | "orbit";
export type Difficulty = { key: DifficultyKey; label: string };

export function difficultyOf(mode: number | null | undefined, graduated = false): Difficulty | null {
  if (graduated) return { key: "orbit", label: "In orbit" };
  if (mode === MODE.EASY) return { key: "easy", label: "Easy" };
  if (mode === MODE.HARD) return { key: "hard", label: "Hard" };
  if (mode === MODE.TRENCH) return { key: "expert", label: "Expert" };
  return null;
}

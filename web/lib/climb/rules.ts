/**
 * Climb: solo Turbo (maker 2026-11-17/18). Five levels you keep. Each level is a fuel, a gear and a $ goal to hit
 * inside one 60 s run. Hit the goal once and the next level unlocks. Beat a higher level's $ goal and you jump to that
 * level ("on dollars", maker). After level 5 is free mode: any level's fuel, any gear up to the venue cap, no clock.
 * Gears top out at 50x because Lighter (the backup venue) caps BTC there. Test out (one 60 s run at a locked level,
 * real money only) unlocks that level on a hit. The screens are public/turbo/duel/engine.js (host.climb).
 */
export interface ClimbLevel { n: number; fuel: number; gear: number; goal: number }

export const CLIMB_LEVELS: readonly ClimbLevel[] = [
  { n: 1, fuel: 12, gear: 10, goal: 0.12 },   // +1% of fuel, a 0.10% BTC move
  { n: 2, fuel: 33, gear: 20, goal: 1 },      // +3%, 0.15%
  { n: 3, fuel: 77, gear: 30, goal: 3.85 },   // +5%, 0.17%
  { n: 4, fuel: 333, gear: 40, goal: 25 },    // +7.5%, 0.19%
  { n: 5, fuel: 1200, gear: 50, goal: 120 },  // +10%, 0.20%
];
/** the level number that means free mode is unlocked */
export const CLIMB_FREE = CLIMB_LEVELS.length + 1;
export const CLIMB_MAX_GEAR = 50;
export const CLIMB_RUN_MS = 60_000;
/** Lighter's locked Turbo fee (PR #479): 1.1 bp round trip, so 0.55 bp a side */
export const CLIMB_FEE = 0.000055;
export const CLIMB_FEE_LABEL = "1.1 bp round trip";

/** the highest level a pilot has unlocked after a run: clearing `level` opens the next one, and a PnL past any
 *  level's goal opens that level. Never goes down. */
export function unlockAfter(unlocked: number, level: number, pnl: number): number {
  let to = Math.max(1, Math.min(CLIMB_FREE, Math.floor(unlocked) || 1));
  if (!(pnl > 0) || level < 1 || level >= CLIMB_FREE) return to;
  const played = CLIMB_LEVELS.find((l) => l.n === level);
  if (played && pnl + 1e-9 >= played.goal) to = Math.max(to, level + 1);
  for (const l of CLIMB_LEVELS) if (pnl + 1e-9 >= l.goal) to = Math.max(to, l.n);
  return Math.min(CLIMB_FREE, to);
}

/** a test out on a locked level: a hit unlocks that level, and a PnL past a higher goal jumps there as usual */
export function unlockAfterTest(unlocked: number, level: number, pnl: number): number {
  let to = Math.max(1, Math.min(CLIMB_FREE, Math.floor(unlocked) || 1));
  const l = CLIMB_LEVELS.find((x) => x.n === level);
  if (!l || !(pnl > 0)) return to;
  if (pnl + 1e-9 >= l.goal) to = Math.max(to, level);
  for (const x of CLIMB_LEVELS) if (pnl + 1e-9 >= x.goal) to = Math.max(to, x.n);
  return Math.min(CLIMB_FREE, to);
}

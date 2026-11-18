/**
 * Climb: solo Turbo (maker 2026-11-17/18). Five levels you keep. Each level is a fuel, a gear and a $ goal to hit
 * inside one 60 s run. Hit the goal once and the next level unlocks. Beat a higher level's $ goal and you jump to that
 * level ("on dollars", maker). After level 5 is free mode: any level's fuel, any gear up to the venue cap, no clock.
 * Gears top out at 50x because Lighter (the backup venue) caps BTC there. No test out (maker 2026-11-18). The screens are public/turbo/duel/engine.js (host.climb).
 */
export interface ClimbLevel { n: number; fuel: number; gear: number; goal: number; /** goal as % of fuel, for the label */ pct?: number }

export const CLIMB_LEVELS: readonly ClimbLevel[] = [
  { n: 1, fuel: 12, gear: 10, goal: 0.12 },   // +1% of fuel, a 0.10% BTC move
  { n: 2, fuel: 33, gear: 20, goal: 1 },      // +3%, 0.15%
  { n: 3, fuel: 77, gear: 30, goal: 3.85 },   // +5%, 0.17%
  { n: 4, fuel: 333, gear: 40, goal: 25 },    // +7.5%, 0.19%
  { n: 5, fuel: 1200, gear: 50, goal: 120 },  // +10%, 0.20%
];
/** the ladder above is drawn for a $1,200 balance. Levels scale with the pilot's balance (maker 2026-11-18: "if they
 *  have $20 or $1k starting, their levels should scale with their deposit"): every level keeps its gear and its % goal,
 *  and its fuel is the same share of the balance (level 5 = the whole balance). Under CLIMB_MIN_BALANCE (play money, an
 *  empty wallet) the $1,200 ladder is used. Unlocked levels are kept whatever the balance does. */
export const CLIMB_BASE = 1200;
export const CLIMB_MIN_BALANCE = 5;
/** no level flies on less than this (or the whole balance, if smaller): a $1 level with a $0.01 goal barely moves the
 *  rocket (maker 2026-11-18 playtest on a $100 balance: "my rocket was just stuck at the bottom") */
export const CLIMB_MIN_FUEL = 10;
export function climbLevelsFor(balance: number): ClimbLevel[] {
  const base = Number.isFinite(balance) && balance >= CLIMB_MIN_BALANCE ? balance : CLIMB_BASE;
  return CLIMB_LEVELS.map((l) => {
    const fuel = Math.max(Math.min(CLIMB_MIN_FUEL, base), Math.floor((base * l.fuel) / CLIMB_BASE * 100) / 100);
    const goal = Math.max(0.01, Math.round(fuel * (l.goal / l.fuel) * 100) / 100);
    return { ...l, fuel, goal, pct: Math.round((l.goal / l.fuel) * 1000) / 10 };
  });
}

/** the level number that means free mode is unlocked */
export const CLIMB_FREE = CLIMB_LEVELS.length + 1;
export const CLIMB_MAX_GEAR = 50;
export const CLIMB_RUN_MS = 60_000;
/** Lighter's locked Turbo fee (PR #479): 1.1 bp round trip, so 0.55 bp a side */
export const CLIMB_FEE = 0.000055;
export const CLIMB_FEE_LABEL = "1.1 bp round trip";

/** goals are checked in whole cents, the way the run screen shows PnL: +$0.12 on screen clears a $0.12 goal
 *  (maker 2026-11-18 playtest: "i got .12 but it said i didnt unlock the next level") */
export const hits = (pnl: number, goal: number): boolean => Math.round(pnl * 100) >= Math.round(goal * 100);

/** the highest level a pilot has unlocked after a run: clearing `level` opens the next one, and a PnL past any
 *  level's goal opens that level. Never goes down. */
export function unlockAfter(unlocked: number, level: number, pnl: number, levels: readonly ClimbLevel[] = CLIMB_LEVELS): number {
  let to = Math.max(1, Math.min(CLIMB_FREE, Math.floor(unlocked) || 1));
  if (!(pnl > 0.004) || level < 1 || level >= CLIMB_FREE) return to;
  const played = levels.find((l) => l.n === level);
  if (played && hits(pnl, played.goal)) to = Math.max(to, level + 1);
  for (const l of levels) if (hits(pnl, l.goal)) to = Math.max(to, l.n);
  return Math.min(CLIMB_FREE, to);
}

/** a test out on a locked level: a hit unlocks that level, and a PnL past a higher goal jumps there as usual */
export function unlockAfterTest(unlocked: number, level: number, pnl: number, levels: readonly ClimbLevel[] = CLIMB_LEVELS): number {
  let to = Math.max(1, Math.min(CLIMB_FREE, Math.floor(unlocked) || 1));
  const l = levels.find((x) => x.n === level);
  if (!l || !(pnl > 0.004)) return to;
  if (hits(pnl, l.goal)) to = Math.max(to, level);
  for (const x of levels) if (hits(pnl, x.goal)) to = Math.max(to, x.n);
  return Math.min(CLIMB_FREE, to);
}

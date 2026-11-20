/** Climb progress on this device, one ladder per mode (maker 2026-11-20: "you have to do sim to unlock sim and real
 *  to unlock real levels"). Simulator keeps the v2 key; Real money starts its own at level 1. The ranked
 *  highest-level board moves to the server with the Lighter / Nova adapter. */
import { CLIMB_FREE } from "./rules";

// v2 (2026-11-20): starts everyone back at level 1. A real-money run on a stale $0 Lighter read counted a Turbo
// deposit as profit and jumped a pilot to level 5 (fixed in ClimbScreen's begin/result).
const KEYS = { sim: "disciple.climb.v2", real: "disciple.climb.real.v1" } as const;
export type ClimbMode = keyof typeof KEYS;

export function readClimbLevel(mode: ClimbMode = "sim"): number {
  try {
    const v = JSON.parse(localStorage.getItem(KEYS[mode]) || "null") as { unlocked?: unknown } | null;
    const n = Math.floor(Number(v?.unlocked));
    return n >= 1 && n <= CLIMB_FREE ? n : 1;
  } catch { return 1; }
}

export function saveClimbLevel(n: number, mode: ClimbMode = "sim"): void {
  try { localStorage.setItem(KEYS[mode], JSON.stringify({ unlocked: Math.max(1, Math.min(CLIMB_FREE, Math.floor(n))) })); } catch { /* private mode */ }
}

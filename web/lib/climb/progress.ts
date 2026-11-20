/** Climb progress on this device. Play money only for now, so the level is kept in the browser; real-money levels
 *  (and the ranked highest-level board) move to the server with the Lighter / Nova adapter. */
import { CLIMB_FREE } from "./rules";

// v2 (2026-11-20): starts everyone back at level 1. A real-money run on a stale $0 Lighter read counted a Turbo
// deposit as profit and jumped a pilot to level 5 (fixed in ClimbScreen's begin/result).
const KEY = "disciple.climb.v2";

export function readClimbLevel(): number {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null") as { unlocked?: unknown } | null;
    const n = Math.floor(Number(v?.unlocked));
    return n >= 1 && n <= CLIMB_FREE ? n : 1;
  } catch { return 1; }
}

export function saveClimbLevel(n: number): void {
  try { localStorage.setItem(KEY, JSON.stringify({ unlocked: Math.max(1, Math.min(CLIMB_FREE, Math.floor(n))) })); } catch { /* private mode */ }
}

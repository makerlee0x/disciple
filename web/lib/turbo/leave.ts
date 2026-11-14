/**
 * Turbo fuel and your cash (Add cash board 5 + 6, maker signed off 2026-11-14: "A is the move", "they should have the
 * option to keep fuel in Turbo", "keep the fee showing for now").
 *  - Load fuel moves dollars from cash into Turbo (USDG on Robinhood Chain → USDC on Arbitrum, Across, ~2 s).
 *  - Leaving Turbo with fuel left asks: Keep fuel in Turbo (the gold one) or Move it to cash (fee shown). "Don't ask
 *    again" saves the answer; Settings › Flying › "Turbo fuel when you leave" changes it.
 *  - Fuel kept in Turbo still counts in the Cash total (lib/turbo/cashFuel).
 * Device-only pref, like lib/turbo/prefs.
 */
export type LeavePref = "ask" | "keep" | "move";
export const LEAVE_PREF_KEY = "disciple.turbo.leave.v1";
export const LEAVE_PREFS: readonly LeavePref[] = ["ask", "keep", "move"];

/** Estimated cost of one move between cash and Turbo (Across fee incl. its gas). maker, Nov 14: keep it showing.
 *  An estimate until the real move quotes it (adapter.moveFeeUsd). */
export const MOVE_FEE_EST_USD = 0.25;

export const LEAVE_COPY = {
  title: "Leaving Turbo",
  body: (left: string) => `You have ${left} of fuel left. Keep it here for next time, or move it back to your cash.`,
  keep: "Keep fuel in Turbo",
  move: (left: string) => `Move ${left} to cash`,
  fee: (fee: string) => `About ${fee} move fee`,
  dontAsk: "Don't ask again. Change it in Settings.",
  moving: "Moving to cash…",
  moved: (v: string) => `${v} is back in your cash`,
  failed: "Couldn't move it right now. Your fuel is still in Turbo.",
  setting: "Turbo fuel when you leave",
  settingHelp: "Keep it in Turbo, or move it back to cash",
  choice: { ask: "Ask", keep: "Keep", move: "Move" } as Record<LeavePref, string>,
} as const;

export const LOAD_COPY = {
  title: "Load fuel",
  lead: "Comes from your cash. When you leave, keep what's left in Turbo or move it back.",
  leadPractice: "Practice fuel on this device only. No real cash moves until Nova connects deposits.",
  yourCash: "Your cash",
  practiceCash: "Practice fuel",
  fee: "Move fee",
  feeVal: (fee: string) => `about ${fee}`,
  load: (v: string) => `Load ${v} fuel`,
  sub: "Takes a couple of seconds.",
  moving: "Loading fuel…",
  movingSub: (v: string) => `Moving ${v} from your cash.`,
  loaded: "Fuel loaded",
  loadedSub: (v: string) => `${v} in the tank. Pick a side and fire.`,
  fly: "Let's go",
  notEnough: "That's more than your cash. Add cash first.",
  addCash: "Add cash",
  all: "All",
  inTank: "In the tank",
  moveBack: "Move to cash",
} as const;

let mem: LeavePref = "ask";
const subs = new Set<(p: LeavePref) => void>();
const store = (s?: Storage | null) => { try { return s ?? (typeof window !== "undefined" ? window.localStorage : null); } catch { return null; } };

export function loadLeavePref(s?: Storage | null): LeavePref {
  try { const v = store(s)?.getItem(LEAVE_PREF_KEY); if (v === "keep" || v === "move" || v === "ask") return (mem = v); } catch { /* ignore */ }
  return mem;
}
export function saveLeavePref(p: LeavePref, s?: Storage | null): void {
  mem = p;
  try { store(s)?.setItem(LEAVE_PREF_KEY, p); } catch { /* memory only */ }
  subs.forEach((cb) => cb(p));
}
export function onLeavePref(cb: (p: LeavePref) => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

/** What leaving Turbo does. No fuel (or dust under a cent) → just leave. Pure, tested. */
export function leaveAction(fuelUsd: number | null | undefined, pref: LeavePref): "leave" | "ask" | "keep" | "move" {
  if (!(typeof fuelUsd === "number" && fuelUsd >= 0.01)) return "leave";
  return pref;
}

/** Fuel chips for Load fuel: $10 / $20 / $30 / All, capped by cash; "All" = whole cash. Pure, tested. */
export function loadPicks(cashUsd: number): { label: string; usd: number }[] {
  const all = Math.floor(Math.max(0, cashUsd) * 100) / 100;
  return [...[10, 20, 30].map((v) => ({ label: `$${v}`, usd: v })), { label: LOAD_COPY.all, usd: all }];
}

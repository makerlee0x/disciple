/**
 * Cash → Turbo transfer that outlives the popup (maker 2026-11-20: "they should be able to close this and still see the
 * deposit countdown ... and give them a notification when it's arrived"). The transfer (lib/lighter/deposit
 * lighterAddCash) runs here, at module level, so closing the Turbo / Cash popup or moving to another page doesn't stop it.
 * The popup's button and the floating chip (components/turbo/TurboLanding) both read this state.
 */
import type { AddCashInfo, AddCashStep } from "@/lib/lighter/deposit";

export type Landing = {
  step: AddCashStep | null;
  /** est. landing time (ms epoch), set once it's sent */
  landsAt?: number;
  /** what Turbo actually credited, once it landed */
  creditedUsd?: number;
  error?: string;
  /** done or failed at (ms epoch); the chip shows the result for a bit */
  endedAt?: number;
};

let state: Landing = { step: null };
const subs = new Set<(l: Landing) => void>();
const emit = () => subs.forEach((f) => f(state));

export const landing = () => state;
export function onLanding(f: (l: Landing) => void): () => void { subs.add(f); f(state); return () => { subs.delete(f); }; }
export const landingBusy = () => state.step != null && state.step !== "done";
export function clearLanding() { if (!landingBusy()) { state = { step: null }; emit(); } }

/** Run one transfer (`run` calls lighterAddCash with the step reporter). Only one at a time. */
export async function startLanding(run: (onStep: (s: AddCashStep, info?: AddCashInfo) => void) => Promise<unknown>): Promise<Landing> {
  if (landingBusy()) return state;
  state = { step: "sending" }; emit();
  try {
    await run((s, info) => {
      state = { ...state, step: s, ...(info?.landsAt ? { landsAt: info.landsAt } : {}), ...(info?.creditedUsd != null ? { creditedUsd: info.creditedUsd } : {}) };
      emit();
    });
    state = { step: "done", creditedUsd: state.creditedUsd, endedAt: Date.now() };
  } catch (e) {
    state = { step: null, error: e instanceof Error ? e.message : String(e), endedAt: Date.now() };
  }
  emit();
  notifyLanded(state);
  return state;
}

/** A system notification when the tab is in the background and the player already allowed notifications. */
function notifyLanded(l: Landing) {
  if (typeof window === "undefined" || l.step !== "done" || document.visibilityState === "visible") return;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Landed in Turbo", { body: l.creditedUsd != null ? `$${l.creditedUsd.toFixed(2)} is in your Turbo cash.` : "Your Turbo cash is in.", tag: "turbo-landed" });
    }
  } catch { /* not allowed here */ }
}

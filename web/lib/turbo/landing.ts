/**
 * Cash → Turbo transfer that outlives the popup (maker 2026-11-20: "they should be able to close this and still see the
 * deposit countdown ... and give them a notification when it's arrived"). The transfer (lib/lighter/deposit
 * lighterAddCash) runs here, at module level, so closing the Turbo / Cash popup or moving to another page doesn't stop it.
 * The popup's button and the floating chip (components/turbo/TurboLanding) both read this state.
 */
import type { AddCashInfo, AddCashStep } from "@/lib/lighter/deposit";
import { REJECTED_MSG } from "@/lib/aa/relayOp";

/** The catch-all line when the transfer stopped before any cash moved (a money fact the player needs to retry safely). */
export const NOT_SENT_MSG = "That didn't go through. Nothing was sent. Try again.";
/** Player copy for a failed transfer: Turbo wording, and the catch-all says nothing moved when that's known. Pure, tested. */
export function landingErrorCopy(shown: string, unsent: boolean): string {
  const t = shown.replace(/Adding cash to Lighter/g, "Moving to Turbo").replace(/Lighter/g, "Turbo");
  return t === REJECTED_MSG && unsent ? NOT_SENT_MSG : t;
}

export type Landing = {
  step: AddCashStep | null;
  /** est. landing time (ms epoch), set once it's sent */
  landsAt?: number;
  /** what Turbo actually credited, once it landed */
  creditedUsd?: number;
  /** player copy (already through playerError), never raw */
  error?: string;
  /** the failure moved no cash */
  nothingSent?: boolean;
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
    // the player copy is made here, from the real error (maker 2026-11-20: a $6 Turbo add only said "That didn't go
    // through" because the popup re-wrapped e.message and lost its code / notSent; the toast showed raw text)
    const at = state.step;
    const { playerError } = await import("@/lib/playerError");
    const { nothingSent } = await import("@/lib/lighter/deposit");
    const unsent = nothingSent(e);
    if (typeof console !== "undefined") console.warn("[disciple] turbo transfer failed", { step: at, nothingSent: unsent, message: String((e as Error)?.message ?? e).slice(0, 300), data: (e as { data?: unknown })?.data, status: (e as { status?: unknown })?.status });
    state = { step: null, error: landingErrorCopy(playerError(e), unsent), nothingSent: unsent, endedAt: Date.now() };
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

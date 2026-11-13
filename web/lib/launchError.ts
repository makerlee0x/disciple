/**
 * The ONE text a player sees when a Quick Launch (/create) launch fails, and whether the Launch button must stay locked.
 * Rebuilt from #231 on the current Quick Launch page. Built on lib/playerError (decoded contract errors → curated copy,
 * raw relay / RPC text → console). The technical detail stays in the caller's console.warn("[disciple] launch failed", …).
 * New strings: copy pending lee approval.
 */
import { CANCELLED_MSG, playerError } from "./playerError";
import { PENDING_MSG, REJECTED_MSG, isTransportError } from "./aa/relayOp";

/** Launch button labels (copy pending lee approval). The idle label stays launchButtonLabel() ("Launch" / "Launch + BOOST $x"). */
export const LAUNCHING_LABEL = "Launching…";
export const LAUNCHED_LABEL = "Launched";
/** Copy pending lee approval. The outcome is unknown, so this must not invite a second click. */
export const LAUNCH_PENDING_MSG = "Your launch is still confirming. Give it a minute before trying again.";
/** Copy pending lee approval. Replaces "Launch didn't go through. Nothing was spent. Try again." */
export const LAUNCH_FAILED_REASON = (reason: string) => `Launch didn't go through (${reason}). Try again.`;
export const LAUNCH_REASON = {
  Estimate: "it failed the final check",
  Reverted: "it was refused at the last step",
  NoLaunchEvent: "it was refused at the last step",
  Bundler: "the launch service is busy",
  network: "the connection dropped before it was sent",
  unknown: "something unexpected went wrong",
} as const;

/**
 * True when the launch outcome is unknown (still confirming: receipt timeout, lost stream, unclear send). The launch may
 * still land, so the Launch button stays locked; only a definite failure (cancel, refused, pre-send check, connection
 * error before sending) releases it.
 */
export function launchStillConfirming(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; extra?: { unclear?: unknown } } | null;
  return e?.code === "Timeout" || e?.extra?.unclear === true || e?.message === PENDING_MSG;
}

export function launchErrorMessage(err: unknown): string {
  const shown = playerError(err);
  if (shown === CANCELLED_MSG) return CANCELLED_MSG;
  if (shown === PENDING_MSG || launchStillConfirming(err)) return LAUNCH_PENDING_MSG;
  if (isTransportError(err)) return LAUNCH_FAILED_REASON(LAUNCH_REASON.network);
  if (shown !== REJECTED_MSG) return shown;   // specific plain copy already mapped: not enough cash, wallet cap, First BOOST too big, …
  const code = (err as { code?: unknown })?.code;
  const reason = typeof code === "string" && code in LAUNCH_REASON ? LAUNCH_REASON[code as keyof typeof LAUNCH_REASON] : LAUNCH_REASON.unknown;
  return LAUNCH_FAILED_REASON(reason);
}

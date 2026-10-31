/**
 * The ONE text a player sees when a /create launch fails. Built on lib/playerError (decoded contract errors → curated
 * copy, raw relay / RPC text → console), with launch wording where the generic trade line would mislead: a launch that
 * is still confirming must not invite a second click (an Easy launch fired 4 times from repeated clicks). The technical
 * detail stays in the caller's console.warn("[disciple] launch failed", …) only. New strings: copy pending lee approval.
 */
import { CANCELLED_MSG, playerError } from "./playerError";
import { NETWORK_MSG, PENDING_MSG, REJECTED_MSG, isTransportError } from "./aa/relayOp";
import { LAUNCH_FAILED_MSG } from "./launchImage";

/** Copy pending lee approval. */
export const LAUNCH_PENDING_MSG = "Your launch is still confirming. Give it a minute before trying again.";
/** Copy pending lee approval. Short plain reason for a launch that failed with only the generic line. */
export const LAUNCH_FAILED_REASON = (reason: string) => `Launch didn't go through (${reason}). Try again.`;
const REASON: Record<string, string> = {
  Estimate: "it failed the final check",
  Reverted: "it was refused at the last step",
  NoLaunchEvent: "it was refused at the last step",
  Bundler: "the launch service is busy",
};

/**
 * True when the launch outcome is unknown (still confirming: receipt timeout, lost stream, unclear send). The launch may
 * still land, so /create keeps the Launch button locked; only a definite failure (cancel, refused, pre-send check,
 * connection error before sending) releases it.
 */
export function launchStillConfirming(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; extra?: { unclear?: unknown } } | null;
  return e?.code === "Timeout" || e?.extra?.unclear === true || e?.message === PENDING_MSG;
}

export function launchErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const shown = playerError(err);
  if (shown === CANCELLED_MSG) return CANCELLED_MSG;
  if (shown === PENDING_MSG || launchStillConfirming(err)) return LAUNCH_PENDING_MSG;
  if (isTransportError(err)) return NETWORK_MSG;
  if (shown !== REJECTED_MSG) return shown;   // specific plain copy: not enough cash, wallet cap, First BOOST too big, …
  const reason = typeof code === "string" ? REASON[code] : undefined;
  return reason ? LAUNCH_FAILED_REASON(reason) : LAUNCH_FAILED_MSG;
}

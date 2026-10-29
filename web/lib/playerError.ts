/**
 * The ONE text a player sees for any thrown error (trade, withdraw, wallet menu, claims, verify). Maps through
 * friendlyError (decoded contract errors → curated copy; raw relay / RPC / simulation text → the plain line) and guards
 * the result: no ids, hex, function / contract error names or chain plumbing wording ever reach the UI — that detail
 * goes to console.warn("[disciple] …"). The error object itself (code, extra, message) is not touched, so retry logic
 * that reads the raw text keeps working. Approved copy: lib/aa/relayOp (lee 2026-10-24).
 */
import { friendlyError } from "./protocol-viem";
import { plainText } from "./aa/relayOp";

export const CANCELLED_MSG = "Cancelled.";

export function playerError(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e);
  if (/user rejected|user denied|request denied/i.test(raw)) return CANCELLED_MSG;
  return plainText(friendlyError(e).message, "player error", { code: (e as { code?: unknown })?.code });
}

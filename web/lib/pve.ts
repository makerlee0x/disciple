/**
 * Client side of the PVE login gate (v4). Before the first PVE curve buy (and at most once per attestation lifetime)
 * the trader needs LoginGate.verifiedUntil(trader, coin) > now. Flow:
 *   1. read verifiedUntil (global attestation, coin = 0, covers every PVE coin) — skip if valid for > 2 min;
 *   2. POST /api/pve/attest with the Privy access token, relay=true → the server verifies the login and relays
 *      LoginGate.attest from the relayer EOA (works with one-tap session keys, which may not call LoginGate);
 *   3. if the relay is unavailable, return the attest call so the caller prepends it to the (owner-signed) batch.
 * The trader is the token RECIPIENT of the curve buy (the smart account), which is what the curve checks.
 */
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { loginGateAbi } from "./abi";
import { deployment, ZERO } from "./chains";
import type { Call } from "./aa/core";

export class PveError extends Error { constructor(public code: string, msg: string) { super(msg); } }

const until = new Map<string, number>();
const nowSec = () => Math.floor(Date.now() / 1000);

/** Privy access token (lazy: the Privy SDK lives in its own chunk). null when not logged in with Privy. */
async function privyAccessToken(): Promise<string | null> {
  try { const m = await import("@privy-io/react-auth"); return (await m.getAccessToken()) ?? null; } catch { return null; }
}

export async function pveVerifiedUntil(pc: PublicClient, trader: Address, coin: Address = ZERO): Promise<number> {
  const gate = deployment().loginGate;
  if (gate === ZERO) return 0;
  return Number(await pc.readContract({ address: gate, abi: loginGateAbi, functionName: "verifiedUntil", args: [trader, coin] }));
}

/**
 * Calls to prepend before a PVE buy by `trader` ([] when already verified or the server relayed the attestation).
 * Throws PveError with user-facing copy when the user can't be attested (no Privy login, unverified login, …).
 */
export async function ensurePveLogin(pc: PublicClient, trader: Address, opts: { fetchFn?: typeof fetch; token?: () => Promise<string | null> } = {}): Promise<Call[]> {
  const gate = deployment().loginGate;
  if (gate === ZERO) throw new PveError("PveUnavailable", "PVE rockets aren't available on this network yet.");
  const k = trader.toLowerCase();
  if ((until.get(k) ?? 0) > nowSec() + 120) return [];
  const onchain = await pveVerifiedUntil(pc, trader).catch(() => 0);
  if (onchain > nowSec() + 120) { until.set(k, onchain); return []; }
  const token = await (opts.token ?? privyAccessToken)();
  if (!token) throw new PveError("PveLoginRequired", "PVE rockets need a verified login — sign in with email or Google first.");
  const r = await (opts.fetchFn ?? fetch)("/api/pve/attest", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ wallet: trader, relay: true }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string; signature?: Hex; expiry?: number; coin?: Address; relayed?: boolean; already?: boolean; verifiedUntil?: number };
  if (!r.ok || !j.signature) {
    const M: Record<string, string> = {
      login_not_verified: "PVE needs a verified login: link an email, Google or X account to your profile.",
      wallet_not_owned: "This wallet isn't linked to your login.",
      rate_limited: "Too many login checks — try again in a few minutes.",
      attester_not_registered: "PVE login checks aren't switched on yet (attester not registered on-chain).",
      pve_attester_not_configured: "PVE login checks aren't configured yet.",
    };
    throw new PveError("PveAttestFailed", M[j.error ?? ""] ?? `PVE login check failed (${j.error ?? r.status}).`);
  }
  if (j.relayed || j.already) { until.set(k, j.verifiedUntil ?? j.expiry ?? 0); return []; }
  // Relay unavailable: submit it ourselves in the same batch (owner-signed; the session policy can't call LoginGate).
  return [{ to: gate, data: encodeFunctionData({ abi: loginGateAbi, functionName: "attest", args: [trader, BigInt(j.expiry!), j.coin ?? ZERO, j.signature] }) }];
}

/** test hook */
export const _resetPveCache = () => until.clear();

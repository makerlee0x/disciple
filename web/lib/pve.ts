/**
 * Global PVE login: read verifiedUntil(trader), then obtain a Privy-backed signature if needed.
 * Return the global attest call for the user's owner-signed batch; users pay gas, with no server relay.
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

export async function pveVerifiedUntil(pc: PublicClient, trader: Address): Promise<number> {
  const gate = deployment().loginGate;
  if (gate === ZERO) return 0;
  return Number(await pc.readContract({ address: gate, abi: loginGateAbi, functionName: "verifiedUntil", args: [trader] }));
}

/**
 * Calls to prepend before a PVE buy by `trader` ([] when already verified).
 * Throws PveError with user-facing copy when the user can't be attested (no Privy login, unverified login, …).
 */
/** Upper bound on the whole PVE login check (on-chain read + token + attest) before a trade gives up. */
export const PVE_LOGIN_BUDGET_MS = 3000;
export const PVE_SLOW_MSG = "Network is slow, trade not sent. Try again.";

/** ensurePveLogin, bounded: a hung check throws PveError("Network", PVE_SLOW_MSG) instead of stalling the trade. */
export async function ensurePveLogin(pc: PublicClient, trader: Address, opts: { fetchFn?: typeof fetch; token?: () => Promise<string | null>; budgetMs?: number } = {}): Promise<Call[]> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const ms = opts.budgetMs ?? PVE_LOGIN_BUDGET_MS;
  return Promise.race([ensurePveLogin1(pc, trader, opts), new Promise<never>((_, rej) => { t = setTimeout(() => rej(new PveError("Network", PVE_SLOW_MSG)), ms); })]).finally(() => clearTimeout(t));
}

async function ensurePveLogin1(pc: PublicClient, trader: Address, opts: { fetchFn?: typeof fetch; token?: () => Promise<string | null> }): Promise<Call[]> {
  const gate = deployment().loginGate;
  if (gate === ZERO) throw new PveError("PveUnavailable", "Easy mode isn't open yet. Try Hard or Trench.");
  const k = trader.toLowerCase();
  if ((until.get(k) ?? 0) > nowSec() + 120) return [];
  const onchain = await pveVerifiedUntil(pc, trader).catch(() => 0);
  if (onchain > nowSec() + 120) { until.set(k, onchain); return []; }
  const token = await (opts.token ?? privyAccessToken)();
  if (!token) throw new PveError("PveLoginRequired", "Easy rockets need you signed in to BOOST. Sign in with X, email or wallet.");
  const r = await (opts.fetchFn ?? fetch)("/api/pve/attest", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ wallet: trader }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string; signature?: Hex; expiry?: number };
  if (!r.ok || !j.signature) {
    const M: Record<string, string> = {
      login_not_verified: "Sign in with X, email or wallet to BOOST Easy rockets.",
      wallet_not_owned: "This wallet isn't linked to your login.",
      rate_limited: "Too many login checks — try again in a few minutes.",
      attester_not_registered: "PVE login checks aren't switched on yet (attester not registered on-chain).",
      pve_attester_not_configured: "PVE login checks aren't configured yet.",
    };
    throw new PveError("PveAttestFailed", M[j.error ?? ""] ?? `PVE login check failed (${j.error ?? r.status}).`);
  }
  // Submit in the user-paid owner-signed batch; the session policy cannot call LoginGate.
  return [{ to: gate, data: encodeFunctionData({ abi: loginGateAbi, functionName: "attest", args: [trader, BigInt(j.expiry!), j.signature] }) }];
}

/**
 * USDG route quotes enforce login before building the buy. Complete a separate USER-PAID owner-signed
 * login setup first (not a server relay); send must resolve only after successful inclusion.
 */
export async function ensurePveLoginOnchain(pc: PublicClient, trader: Address, send: (calls: Call[]) => Promise<unknown>, opts: Parameters<typeof ensurePveLogin>[2] = {}): Promise<void> {
  const calls = await ensurePveLogin(pc, trader, opts);
  if (calls.length) await send(calls);
}

/** test hook */
export const _resetPveCache = () => until.clear();

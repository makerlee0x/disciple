import "server-only";
/**
 * Off-chain login gate for the gasless relay (lee, Nov 9 7:37 PM CT: "why do we have to record onchain that theyre
 * verified? … get rid of it"). Replaces the per-session LoginGate.attest + on-chain verifiedUntil admission read.
 *
 * Pattern: app-level gating, as pump.fun and FOMO do it — login is enforced by the app/relay that pays the gas, not
 * recorded on-chain. The relay only spends ETH for a request carrying a valid Privy session whose wallet is the signer.
 *
 * Check (reuses lib/server/privyAuth, the repo's existing server-side Privy verification used by /api/verify + invites):
 *  1. token: `Authorization: Bearer <Privy access token>` — ES256 signature against PRIVY_VERIFICATION_KEY or the app
 *     JWKS (fixed host auth.privy.io), iss privy.io, aud = our app id, exp/nbf (60 s skew), sub did:privy:… Local
 *     crypto only (keys cached 10 min) ⇒ ~1 ms. Missing / bad / expired ⇒ rejected.
 *  2. user: GET api.privy.io/v1/users/{did} (app secret), positive-cached 60 s per did (privyAuth). The Permit2 signer
 *     must be one of the user's linked ethereum wallets (embedded or linked EOA) — exact address match; the user must
 *     have a verified login (email / google_oauth / twitter_oauth — the same VERIFIED_LOGIN_TYPES /api/pve/attest
 *     required before it would sign a LoginGate attestation); invite gate (same requireInviteUser as attest).
 * Revoke marker, strike ledger, per-IP / per-sender / global caps, loss breaker and the exact eth_call stay in
 * gaslessRelay. Fail closed: no Privy config ⇒ every gasless trade is refused.
 */
import { fetchPrivyUser, privyEnv, verificationKeys, verifyAccessToken, type FetchLike, type PrivyEnv, type PrivyUser } from "./privyAuth";
import { requireInviteUser } from "./inviteGate";

/** Same set as lib/pveAttest VERIFIED_LOGIN_TYPES (what /api/pve/attest required for a LoginGate attestation). */
export const SESSION_LOGIN_TYPES = new Set(["email", "google_oauth", "twitter_oauth"]);

export type SessionDeps = { env: () => PrivyEnv; fetch?: FetchLike; invite: (did: string) => Promise<{ ok: boolean }>; nowMs?: () => number };
/** Injectable for tests (production: process env + global fetch + the invite gate). */
export const gaslessSessionDeps: SessionDeps = {
  env: () => privyEnv(),
  invite: (did) => requireInviteUser(did, "gasless"),
};

export class SessionReject extends Error { notSent = true; constructor(m: string, public status = 401) { super(m); } }

/** Stage 1 (local crypto, no network beyond the cached key set): the token is a live Privy session. → did. */
export async function verifySessionToken(token: string | null | undefined, d: SessionDeps = gaslessSessionDeps): Promise<string> {
  const pe = d.env();
  if (!pe.appId) throw new SessionReject("gasless login check isn't configured", 503);
  if (!token) throw new SessionReject("sign in first: no Privy session");
  const now = d.nowMs?.() ?? Date.now();
  const keys = await verificationKeys(pe, d.fetch, now);
  if (!keys.length) throw new SessionReject("gasless login check isn't configured", 503);
  const c = verifyAccessToken(token, keys, pe.appId, Math.floor(now / 1000));
  if (!c) throw new SessionReject("Privy session invalid or expired: sign in again");
  return c.sub;
}

/** Stage 2 (after stage 1 verified the token ⇒ `did`): the session's user owns `signer` (linked wallet), has a
 *  verified login, and passes the invite gate. User lookup and invite gate run in parallel. */
export async function requireSessionWallet(did: string, signer: string, d: SessionDeps = gaslessSessionDeps): Promise<PrivyUser> {
  const pe = d.env();
  if (!pe.appSecret) throw new SessionReject("gasless login check isn't configured", 503);
  const [u, inv] = await Promise.all([fetchPrivyUser(did, pe, d.fetch, d.nowMs?.() ?? Date.now()), d.invite(did)]);
  if (!u) throw new SessionReject("couldn't load your Privy account");
  if (!u.wallets.includes(signer.toLowerCase())) throw new SessionReject("signer is not this Privy session's wallet", 403);
  if (!(u.logins ?? []).some((t) => SESSION_LOGIN_TYPES.has(t))) throw new SessionReject("login not verified (email, Google or X)", 403);
  if (!inv.ok) throw new SessionReject("invite required", 403);
  return u;
}

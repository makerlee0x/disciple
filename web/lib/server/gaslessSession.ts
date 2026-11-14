import "server-only";
/**
 * Off-chain login gate for the gasless relay (lee, Nov 9 7:37 PM CT: "why do we have to record onchain that theyre
 * verified? … get rid of it"; AUDIT M2, lee 8:25 PM CT: use identity tokens). Replaces the per-session LoginGate.attest
 * + on-chain verifiedUntil admission read, and does NOT call GET api.privy.io/v1/users/{did} on the trade path.
 *
 * Pattern: app-level gating, as pump.fun and FOMO do it — login is enforced by the app/relay that pays the gas, not
 * recorded on-chain. The relay only spends ETH for a request carrying a valid Privy *identity token* whose linked
 * wallet is the signer.
 *
 * Privy docs (cite): "Lookups by user ID are subject to rate limits. When accessing an authenticated user, use
 * identity tokens" — https://docs.privy.io/user-management/users/managing-users/querying-users
 * Identity token format / local verify: https://docs.privy.io/user-management/users/identity-tokens
 * Dashboard (NOT changed here): User management → Authentication → Advanced → "Return user data in an identity token".
 *
 * Check (reuses lib/server/privyAuth verification keys + ES256 verifyIdentityToken):
 *  1. token: `privy-id-token` header (or cookie of the same name) — ES256 against PRIVY_VERIFICATION_KEY or the app
 *     JWKS (fixed host auth.privy.io), iss privy.io, aud = our app id, exp/nbf (60 s skew), sub did:privy:…, and a
 *     stringified `linked_accounts` claim. Local crypto only (keys cached 10 min) ⇒ ~1 ms. Missing / bad / expired ⇒
 *     rejected. No users-API fallback: a missing or invalid identity token is a clean refusal.
 *  2. The Permit2 signer must be one of the token's linked ethereum wallets (exact address match); the user must
 *     have a verified login (email / google_oauth / twitter_oauth — SESSION_LOGIN_TYPES);
 *     invite gate (requireInviteUser).
 * Revoke/ban/strike (wallet + did), per-IP / per-sender / global caps, loss breaker and the exact eth_call stay in
 * gaslessRelay. Fail closed: no Privy config ⇒ every gasless trade is refused.
 */
import { privyEnv, verificationKeys, verifyIdentityToken, type FetchLike, type PrivyEnv, type PrivyUser } from "./privyAuth";
import { requireInviteUser } from "./inviteGate";

/** Privy login types that count as a verified login for gasless trades (app-level gating, pump.fun / FOMO style). */
export const SESSION_LOGIN_TYPES = new Set(["email", "google_oauth", "twitter_oauth"]);

export type SessionDeps = { env: () => PrivyEnv; fetch?: FetchLike; invite: (did: string) => Promise<{ ok: boolean }>; nowMs?: () => number };
/** Injectable for tests (production: process env + global fetch + the invite gate). */
export const gaslessSessionDeps: SessionDeps = {
  env: () => privyEnv(),
  invite: (did) => requireInviteUser(did, "gasless"),
};

export class SessionReject extends Error { notSent = true; constructor(m: string, public status = 401) { super(m); } }

export type IdentitySession = { did: string; user: PrivyUser };

/** Local crypto, no users-API: the identity token is a live Privy session with linked accounts. */
export async function verifySessionToken(token: string | null | undefined, d: SessionDeps = gaslessSessionDeps): Promise<IdentitySession> {
  const pe = d.env();
  if (!pe.appId) throw new SessionReject("gasless login check isn't configured", 503);
  if (!token) throw new SessionReject("sign in first: no Privy identity token");
  const now = d.nowMs?.() ?? Date.now();
  const keys = await verificationKeys(pe, d.fetch, now);
  if (!keys.length) throw new SessionReject("gasless login check isn't configured", 503);
  const c = verifyIdentityToken(token, keys, pe.appId, Math.floor(now / 1000));
  if (!c) throw new SessionReject("Privy session invalid or expired: sign in again");
  return { did: c.sub, user: c.user };
}

/** The identity token's user owns `signer` (linked wallet), has a verified login, and passes the invite gate. */
export async function requireSessionWallet(session: IdentitySession, signer: string, d: SessionDeps = gaslessSessionDeps): Promise<PrivyUser> {
  const u = session.user;
  if (!u.wallets.includes(signer.toLowerCase())) throw new SessionReject("signer is not this Privy session's wallet", 403);
  if (!(u.logins ?? []).some((t) => SESSION_LOGIN_TYPES.has(t))) throw new SessionReject("login not verified (email, Google or X)", 403);
  const inv = await d.invite(session.did);
  if (!inv.ok) throw new SessionReject("invite required", 403);
  return u;
}

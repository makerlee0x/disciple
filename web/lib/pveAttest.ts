/**
 * PVE login attestations (LoginGate, contracts/src/LoginGate.sol on main). Pure + injectable (no `server-only`) so
 * scripts/test-pve-attest.mts can unit-test it; the route is app/api/pve/attest.
 *
 * Contract facts (LoginGate @ 0xe900…b69f, EIP712("DisciplePVE", "1")):
 *   LoginAttestation(address wallet,uint64 expiry,address coin)   coin = address(0) ⇒ valid for every PVE coin
 *   attest(wallet, expiry, coin, sig): permissionless submit, requires block.timestamp < expiry ≤ now + MAX_TTL (24h),
 *   ECDSA.recover(digest) == attester. There is NO nonce: replaying a signature only re-records the same expiry.
 *   PVE curves read verifiedUntil(trader, coin) on the trader's next buy (trader = the token RECIPIENT, i.e. the smart
 *   account) and cache it for ≤ 10 min.
 * So the flow is a SEPARATE attest tx before the first PVE buy (not a signature passed into buy).
 */
import { createPublicKey, verify as cryptoVerify } from "crypto";
import { parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const PVE_DOMAIN_NAME = "DisciplePVE";
export const PVE_DOMAIN_VERSION = "1";
export const LOGIN_TYPES = {
  LoginAttestation: [
    { name: "wallet", type: "address" },
    { name: "expiry", type: "uint64" },
    { name: "coin", type: "address" },
  ],
} as const;
/** LoginGate.MAX_TTL = 24h. Stay under it so chain/server clock skew can't trip TtlTooLong. */
export const MAX_TTL_SEC = 24 * 3600 - 600;
export const DEFAULT_TTL_SEC = 12 * 3600;
export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
/** Login methods that count as "login-verified" for PVE (a real Privy identity, not just a wallet). */
export const VERIFIED_LOGIN_TYPES = new Set(["email", "google_oauth", "twitter_oauth"]);

export const loginGateMiniAbi = parseAbi([
  "function attest(address wallet, uint64 expiry, address coin, bytes sig)",
  "function verifiedUntil(address wallet, address coin) view returns (uint64)",
  "function attester() view returns (address)",
]);

export type Attestation = { wallet: Address; expiry: number; coin: Address; signature: Hex; loginGate: Address; chainId: number; attester: Address };

export function attestTtl(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PVE_ATTEST_TTL_SEC);
  return Number.isFinite(n) && n >= 300 ? Math.min(MAX_TTL_SEC, Math.floor(n)) : DEFAULT_TTL_SEC;
}

/** The attester account, or null when PVE_ATTESTER_PRIVATE_KEY is unset/invalid (callers must FAIL CLOSED). Never logs the key. */
export function attesterAccount(env: Record<string, string | undefined> = process.env) {
  const k = (env.PVE_ATTESTER_PRIVATE_KEY || "").trim();
  if (!k) return null;
  try { return privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex); } catch { return null; }
}

export async function signLoginAttestation(
  account: NonNullable<ReturnType<typeof attesterAccount>>,
  a: { wallet: Address; expiry: number; coin: Address; chainId: number; loginGate: Address },
): Promise<Hex> {
  return account.signTypedData({
    domain: { name: PVE_DOMAIN_NAME, version: PVE_DOMAIN_VERSION, chainId: a.chainId, verifyingContract: a.loginGate },
    types: LOGIN_TYPES,
    primaryType: "LoginAttestation",
    message: { wallet: a.wallet, expiry: BigInt(a.expiry), coin: a.coin },
  });
}

/* ---------------- Privy access token (ES256 JWT) ---------------- */

export type Jwk = { kty: string; crv?: string; x?: string; y?: string; kid?: string; alg?: string; use?: string };
export type PrivyClaims = { userId: string; sessionId: string; exp: number; iat: number };
export class AuthError extends Error { constructor(public code: string, msg?: string) { super(msg ?? code); } }

const b64u = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Verify a Privy access token: ES256 signature against the app JWKS (https://auth.privy.io/api/v1/apps/<appId>/jwks.json),
 * iss "privy.io", aud == appId, exp/nbf with 30s skew. Returns the Privy DID (sub) + session id. Throws AuthError.
 */
export async function verifyPrivyAccessToken(token: string, appId: string, getJwks: () => Promise<Jwk[]>, nowSec = Math.floor(Date.now() / 1000)): Promise<PrivyClaims> {
  if (!appId) throw new AuthError("privy_not_configured");
  const parts = (token || "").split(".");
  if (parts.length !== 3) throw new AuthError("bad_token");
  let header: { alg?: string; kid?: string; typ?: string }, payload: Record<string, unknown>;
  try { header = JSON.parse(b64u(parts[0]).toString("utf8")); payload = JSON.parse(b64u(parts[1]).toString("utf8")); } catch { throw new AuthError("bad_token"); }
  if (header.alg !== "ES256") throw new AuthError("bad_alg");
  const keys = (await getJwks()).filter((k) => k.kty === "EC" && (!k.crv || k.crv === "P-256"));
  const jwk = (header.kid ? keys.find((k) => k.kid === header.kid) : undefined) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new AuthError("unknown_key");
  let ok = false;
  try {
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as never, format: "jwk" });
    ok = cryptoVerify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, b64u(parts[2]));
  } catch { ok = false; }
  if (!ok) throw new AuthError("bad_signature");
  const aud = payload.aud;
  if (payload.iss !== "privy.io") throw new AuthError("bad_issuer");
  if (!(aud === appId || (Array.isArray(aud) && aud.includes(appId)))) throw new AuthError("bad_audience");
  const exp = Number(payload.exp), iat = Number(payload.iat ?? 0), nbf = Number(payload.nbf ?? 0);
  if (!Number.isFinite(exp) || exp + 30 < nowSec) throw new AuthError("expired");
  if (nbf && nbf - 30 > nowSec) throw new AuthError("not_yet_valid");
  if (typeof payload.sub !== "string" || !payload.sub.startsWith("did:privy:")) throw new AuthError("bad_subject");
  return { userId: payload.sub, sessionId: String(payload.sid ?? ""), exp, iat };
}

/** JWKS fetcher with a 1h in-process cache (Privy rotates rarely; a miss on an unknown kid refetches once). */
export function privyJwksFetcher(appId: string, fetchFn: typeof fetch = fetch) {
  let cache: { at: number; keys: Jwk[] } | null = null;
  return async (): Promise<Jwk[]> => {
    if (cache && Date.now() - cache.at < 3600_000) return cache.keys;
    const r = await fetchFn(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`, { cache: "no-store" } as RequestInit);
    if (!r.ok) throw new AuthError("jwks_unavailable", `jwks ${r.status}`);
    const j = (await r.json()) as { keys?: Jwk[] };
    cache = { at: Date.now(), keys: j.keys ?? [] };
    return cache.keys;
  };
}

/* ---------------- Privy user (server API, app secret) ---------------- */

export type PrivyLinkedAccount = { type: string; address?: string; wallet_client_type?: string; chain_type?: string; verified_at?: number };
export type PrivyUser = { id: string; linked_accounts: PrivyLinkedAccount[] };

export async function fetchPrivyUser(userId: string, appId: string, appSecret: string, fetchFn: typeof fetch = fetch): Promise<PrivyUser> {
  if (!appSecret) throw new AuthError("privy_not_configured");
  const r = await fetchFn(`https://auth.privy.io/api/v1/users/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`, "privy-app-id": appId },
    cache: "no-store",
  } as RequestInit);
  if (r.status === 404) throw new AuthError("unknown_user");
  if (!r.ok) throw new AuthError("privy_unavailable", `privy users ${r.status}`);
  return (await r.json()) as PrivyUser;
}

export const isLoginVerified = (u: PrivyUser) => (u.linked_accounts || []).some((a) => VERIFIED_LOGIN_TYPES.has(a.type));

/** EVM addresses Privy links to the user (embedded + external wallets, Privy smart wallets). Lowercase. */
export const linkedEvmAddresses = (u: PrivyUser) =>
  (u.linked_accounts || [])
    .filter((a) => (a.type === "wallet" || a.type === "smart_wallet") && (!a.chain_type || a.chain_type === "ethereum") && typeof a.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.address))
    .map((a) => a.address!.toLowerCase());

/**
 * Does `wallet` belong to this Privy user? Either a linked EVM address, or the counterfactual smart account (MAv2
 * SemiModular, else LightAccount v2; salt 0 — lib/aa) OWNED by one of the user's linked wallets. `predict` resolves
 * owner → [mav2, lightAccount] addresses (on-chain factory views; tests pass a fake).
 */
export async function walletBelongsTo(u: PrivyUser, wallet: string, predict: (owner: Address) => Promise<(string | null)[]>): Promise<boolean> {
  const w = wallet.toLowerCase();
  const owners = linkedEvmAddresses(u);
  if (owners.includes(w)) return true;
  for (const o of owners) {
    const preds = await predict(o as Address).catch(() => [] as (string | null)[]);
    if (preds.some((p) => typeof p === "string" && p.toLowerCase() === w)) return true;
  }
  return false;
}

/**
 * Server-side Privy session auth (no wallet signatures): verify the Privy ACCESS TOKEN (ES256 JWT) and resolve the
 * user's linked emails / wallets.
 *  - signature: ES256 over the app's verification key — PRIVY_VERIFICATION_KEY (PEM from Dashboard → App settings;
 *    "\n"-escaped is fine). Unset ⇒ the app's JWKS from the FIXED host auth.privy.io (app id validated, never a
 *    caller-supplied URL ⇒ no SSRF). Neither available ⇒ every request is rejected (fail closed).
 *  - claims: alg ES256, iss "privy.io", aud = our app id, exp in the future (60 s skew), sub = did:privy:…
 *  - user: GET https://api.privy.io/v1/users/{did} (Basic appId:PRIVY_APP_SECRET), cached 60 s. Emails are taken from
 *    `email` and `google_oauth` linked accounts only; wallets from linked ethereum wallets.
 * Pure node (no server-only, fetch/clock injectable): unit-tested by scripts/test-verify-api.mts.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "crypto";

export type PrivyClaims = { sub: string; sid?: string; exp: number; iat?: number };
export type PrivyUser = { id: string; emails: string[]; wallets: string[] };
export type PrivyEnv = { appId: string; appSecret?: string; verificationKey?: string };
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const DID_RE = /^did:privy:[a-z0-9]{8,64}$/;
const APP_RE = /^[a-z0-9]{8,64}$/i;
const b64u = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Server env → Privy config. Preview deployments use the preview app (mirrors lib/aa/session PRIVY_APP_ID). */
export function privyEnv(env: NodeJS.ProcessEnv = process.env): PrivyEnv {
  const preview = (env.VERCEL_ENV || env.NEXT_PUBLIC_VERCEL_ENV) === "preview" && env.NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW;
  return {
    appId: (preview || env.NEXT_PUBLIC_PRIVY_APP_ID || "").trim(),
    appSecret: ((preview ? env.PRIVY_APP_SECRET_PREVIEW : undefined) || env.PRIVY_APP_SECRET || "").trim() || undefined,
    verificationKey: ((preview ? env.PRIVY_VERIFICATION_KEY_PREVIEW : undefined) || env.PRIVY_VERIFICATION_KEY || "").replace(/\\n/g, "\n").trim() || undefined,
  };
}

const keyCache = new Map<string, { at: number; keys: KeyObject[] }>();
/** Verification keys: the PEM env, else the app JWKS (cached 10 min). */
export async function verificationKeys(pe: PrivyEnv, f: FetchLike = fetch as unknown as FetchLike, now = Date.now()): Promise<KeyObject[]> {
  if (pe.verificationKey) return [createPublicKey(pe.verificationKey)];
  if (!APP_RE.test(pe.appId)) return [];
  const hit = keyCache.get(pe.appId);
  if (hit && now - hit.at < 600_000) return hit.keys;
  try {
    const r = await f(`https://auth.privy.io/api/v1/apps/${pe.appId}/jwks.json`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j = (await r.json()) as { keys?: Record<string, unknown>[] };
    const keys = (j.keys ?? []).filter((k) => k.kty === "EC" && k.crv === "P-256").map((k) => createPublicKey({ key: k as never, format: "jwk" }));
    keyCache.set(pe.appId, { at: now, keys });
    return keys;
  } catch { return []; }
}

/** Verify a Privy access token. Returns its claims, or null (bad signature / claims / expired / no key). */
export function verifyAccessToken(token: string, keys: KeyObject[], appId: string, nowSec = Math.floor(Date.now() / 1000)): PrivyClaims | null {
  if (!keys.length || !appId || typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string }, claims: Record<string, unknown>;
  try { header = JSON.parse(b64u(parts[0]).toString("utf8")); claims = JSON.parse(b64u(parts[1]).toString("utf8")); } catch { return null; }
  if (header.alg !== "ES256") return null;
  const sig = b64u(parts[2]);
  if (sig.length !== 64) return null;
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!keys.some((k) => { try { return cryptoVerify("sha256", data, { key: k, dsaEncoding: "ieee-p1363" }, sig); } catch { return false; } })) return null;
  const aud = claims.aud;
  if (claims.iss !== "privy.io") return null;
  if (!(aud === appId || (Array.isArray(aud) && aud.includes(appId)))) return null;
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp + 60 < nowSec) return null;
  if (claims.nbf != null && Number(claims.nbf) - 60 > nowSec) return null;
  const sub = String(claims.sub ?? "");
  if (!DID_RE.test(sub)) return null;
  return { sub, sid: claims.sid ? String(claims.sid) : undefined, exp, iat: claims.iat ? Number(claims.iat) : undefined };
}

const userCache = new Map<string, { at: number; u: PrivyUser }>();
/** Linked emails (lowercased) + ethereum wallets of a Privy user, from the Privy REST API. null on any failure. */
export async function fetchPrivyUser(did: string, pe: PrivyEnv, f: FetchLike = fetch as unknown as FetchLike, now = Date.now()): Promise<PrivyUser | null> {
  if (!DID_RE.test(did) || !pe.appSecret || !APP_RE.test(pe.appId)) return null;
  const hit = userCache.get(did);
  if (hit && now - hit.at < 60_000) return hit.u;
  try {
    const r = await f(`https://api.privy.io/v1/users/${encodeURIComponent(did)}`, {
      headers: { authorization: "Basic " + Buffer.from(`${pe.appId}:${pe.appSecret}`).toString("base64"), "privy-app-id": pe.appId },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { id?: string; linked_accounts?: Record<string, unknown>[] };
    if (j.id !== did) return null;
    const emails = new Set<string>(), wallets = new Set<string>();
    for (const a of j.linked_accounts ?? []) {
      if (a.type === "email" && typeof a.address === "string") emails.add(a.address.trim().toLowerCase());
      if (a.type === "google_oauth" && typeof a.email === "string") emails.add(a.email.trim().toLowerCase());
      if (a.type === "wallet" && a.chain_type === "ethereum" && typeof a.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.address)) wallets.add(a.address.toLowerCase());
    }
    const u = { id: did, emails: Array.from(emails), wallets: Array.from(wallets) };
    if (userCache.size > 5000) userCache.clear();
    userCache.set(did, { at: now, u });
    return u;
  } catch { return null; }
}

/** ADMIN_EMAILS → set of lowercased emails. Unset/blank ⇒ null ⇒ callers MUST fail closed. */
export function parseAdminEmails(v: string | undefined): Set<string> | null {
  const s = new Set((v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)));
  return s.size ? s : null;
}
export const isAdminUser = (u: PrivyUser | null, allow: Set<string> | null) => !!u && !!allow && u.emails.some((e) => allow.has(e));

export const bearer = (h: { get(n: string): string | null }) => {
  const v = h.get("authorization") || "";
  return /^Bearer [A-Za-z0-9_\-.]+$/.test(v) ? v.slice(7) : null;
};

export type AuthResult = { ok: true; user: PrivyUser } | { ok: false; status: 401 | 403 | 503; reason: string };
/** Token → verified Privy user (with emails/wallets). */
export async function authenticate(token: string | null, pe: PrivyEnv, f: FetchLike = fetch as unknown as FetchLike, nowMs = Date.now()): Promise<AuthResult> {
  if (!pe.appId) return { ok: false, status: 503, reason: "Login isn't configured." };
  if (!token) return { ok: false, status: 401, reason: "Sign in first." };
  const keys = await verificationKeys(pe, f, nowMs);
  if (!keys.length) return { ok: false, status: 503, reason: "Login check isn't configured." };
  const c = verifyAccessToken(token, keys, pe.appId, Math.floor(nowMs / 1000));
  if (!c) return { ok: false, status: 401, reason: "Session expired. Sign in again." };
  if (!pe.appSecret) return { ok: false, status: 503, reason: "Login check isn't configured." };
  const user = await fetchPrivyUser(c.sub, pe, f, nowMs);
  if (!user) return { ok: false, status: 401, reason: "Couldn't load your account." };
  return { ok: true, user };
}
/** authenticate + ADMIN_EMAILS allowlist (unset ⇒ 503, fail closed; not listed ⇒ 403). */
export async function authenticateAdmin(token: string | null, pe: PrivyEnv, adminEmails: string | undefined, f?: FetchLike, nowMs?: number): Promise<AuthResult> {
  const allow = parseAdminEmails(adminEmails);
  if (!allow) return { ok: false, status: 503, reason: "Admin access isn't configured." };
  const a = await authenticate(token, pe, f, nowMs);
  if (!a.ok) return a;
  if (!isAdminUser(a.user, allow)) return { ok: false, status: 403, reason: "Not an admin." };
  return a;
}

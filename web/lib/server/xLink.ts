import "server-only";
/**
 * X account linking, server side (see lib/xLink.ts for the flow). OAuth 2.0 authorization code with PKCE, confidential
 * client (Basic auth on the token call). Only the `users.read tweet.read` scopes: we read who you are, never post.
 *
 * KV keys:
 *   x:state:<state>    → JSON { wallet, verifier, returnTo }   single use (getDel), 10 min, bound to the browser by cookie
 *   user:x:<wallet>    → JSON XLink
 *   x:id:<x user id>   → wallet                                reverse index: one X account ↔ one wallet
 * The access token is used once to read /2/users/me and is never stored.
 *
 * Env: X_CLIENT_ID, X_CLIENT_SECRET (X developer app, OAuth 2.0, type "Web App"), optional X_REDIRECT_URI
 * (default <request origin>/api/x/callback; it must match a callback URL registered on the app).
 */
import { createHash, randomBytes } from "node:crypto";
import { kv } from "./kv";
import { isXUsername, type XLink } from "@/lib/xLink";

const STATE_TTL = 600;
/** Nonce prefix for the signed connect / disconnect requests (lib/server/nonces). */
export const X_NONCE_PREFIX = "x:nonce";
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const ME_URL = "https://api.x.com/2/users/me";
const SCOPES = "users.read tweet.read";

const stateKey = (s: string) => `x:state:${s}`;
const linkKey = (w: string) => `user:x:${w.toLowerCase()}`;
const idKey = (id: string) => `x:id:${id}`;

export const xConfigured = (env: NodeJS.ProcessEnv = process.env) => !!(env.X_CLIENT_ID && env.X_CLIENT_SECRET);

export const redirectUri = (origin: string, env: NodeJS.ProcessEnv = process.env) => env.X_REDIRECT_URI || `${origin}/api/x/callback`;

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Pure (tests): PKCE S256 challenge for a verifier. */
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

/** Only same-site paths come back from the callback (no open redirect). */
export function safeReturnTo(v: unknown): string {
  return typeof v === "string" && /^\/(?![/\\])[A-Za-z0-9/_\-?=&#.%]*$/.test(v) && v.length <= 200 ? v : "/profile";
}

/**
 * The state is also set as an httpOnly cookie on the browser that signed the connect request, and the callback only
 * finishes when the cookie matches. Without it, someone could start a link for their own wallet and get another person
 * to approve the X screen, linking that person's X account to the wrong wallet.
 */
export const X_STATE_COOKIE = "dsc_x_state";

/** Pure (tests): the callback's state must equal the cookie the connect request set. Constant time. */
export function stateMatchesCookie(state: string, cookie: string | null | undefined): boolean {
  if (!state || !cookie || state.length !== cookie.length) return false;
  let d = 0;
  for (let i = 0; i < state.length; i++) d |= state.charCodeAt(i) ^ cookie.charCodeAt(i);
  return d === 0;
}

/** Step 1: a fresh state + PKCE pair for this wallet, and the X authorize URL to send the browser to. */
export async function beginLink(wallet: string, origin: string, returnTo: string): Promise<{ url: string; state: string }> {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const ok = await kv().setNX(stateKey(state), JSON.stringify({ wallet: wallet.toLowerCase(), verifier, returnTo: safeReturnTo(returnTo) }), STATE_TTL);
  if (!ok) throw new Error("state collision");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.X_CLIENT_ID || "",
    redirect_uri: redirectUri(origin),
    scope: SCOPES,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  return { url: `${AUTHORIZE_URL}?${q.toString()}`, state };
}

export type FinishResult =
  | { ok: true; link: XLink; returnTo: string }
  | { ok: false; reason: "expired" | "taken" | "error"; returnTo: string };

type Fetch = typeof fetch;

/** Step 3: swap the code, read the account, store the link. The state is single use. */
export async function finishLink(state: string, code: string, origin: string, f: Fetch = fetch): Promise<FinishResult> {
  const raw = state ? await kv().getDel(stateKey(state)) : null;
  if (!raw) return { ok: false, reason: "expired", returnTo: "/profile" };
  let st: { wallet: string; verifier: string; returnTo: string };
  try { st = JSON.parse(raw); } catch { return { ok: false, reason: "error", returnTo: "/profile" }; }
  const returnTo = safeReturnTo(st.returnTo);
  try {
    const basic = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString("base64");
    const tok = await f(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(origin), code_verifier: st.verifier }).toString(),
      cache: "no-store",
    });
    if (!tok.ok) return { ok: false, reason: "error", returnTo };
    const { access_token } = (await tok.json()) as { access_token?: string };
    if (!access_token) return { ok: false, reason: "error", returnTo };
    const me = await f(ME_URL, { headers: { authorization: `Bearer ${access_token}` }, cache: "no-store" });
    if (!me.ok) return { ok: false, reason: "error", returnTo };
    const { data } = (await me.json()) as { data?: { id?: string; username?: string } };
    if (!data?.id || !/^\d{1,25}$/.test(data.id) || !isXUsername(data.username)) return { ok: false, reason: "error", returnTo };

    // One X account ↔ one wallet. Claim the reverse index first (NX), so two wallets can't race onto one account.
    const wallet = st.wallet;
    const claimed = await kv().setNX(idKey(data.id), wallet, 0);
    if (!claimed) {
      const holder = await kv().get(idKey(data.id));
      if (holder !== wallet) return { ok: false, reason: "taken", returnTo };
    }
    // A wallet relinking a different X account frees its old one.
    const prev = await linkOf(wallet);
    if (prev && prev.id !== data.id) await kv().delIfEq(idKey(prev.id), wallet);
    const link: XLink = { id: data.id, username: data.username, linkedAt: Date.now() };
    await kv().set(linkKey(wallet), JSON.stringify(link));
    return { ok: true, link, returnTo };
  } catch {
    return { ok: false, reason: "error", returnTo };
  }
}

export async function linkOf(wallet: string): Promise<XLink | null> {
  const raw = await kv().get(linkKey(wallet));
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<XLink>;
    return typeof j.id === "string" && isXUsername(j.username) && typeof j.linkedAt === "number" ? { id: j.id, username: j.username, linkedAt: j.linkedAt } : null;
  } catch { return null; }
}

export async function unlink(wallet: string): Promise<void> {
  const prev = await linkOf(wallet);
  if (prev) await kv().delIfEq(idKey(prev.id), wallet.toLowerCase());
  await kv().del(linkKey(wallet));
}

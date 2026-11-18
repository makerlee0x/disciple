export const runtime = "nodejs";
/**
 * Join the signed-in player's wallets into one XP account (lib/server/xpAccount): XP, level, trophies and parts then read
 * the same on every device, whichever login method (email, Google, Apple) each one used.
 * POST { address } with `Authorization: Bearer <Privy access token>` (or a `privy-id-token` header, verified locally)
 * → { ok: true, wallets: number, joined: number } | { ok: false, reason, duplicate?: { method, join, email } }
 * duplicate: this email already belongs to an earlier login (lib/server/xpAccount duplicateLogin). One account per person:
 * the client signs out, signs in with `method` and links `join` onto that account (methods: email | google | apple).
 * Nothing is linked here.
 * The address must be one of the Privy user's wallets. Called once per sign-in by lib/xpClient linkXpAccount.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, fetchPrivyUser, privyEnv, verificationKeys, verifyIdentityToken, type PrivyUser } from "@/lib/server/privyAuth";
import { duplicateLogin, linkAccount, LOGIN_LABEL } from "@/lib/server/xpAccount";

export const dynamic = "force-dynamic";
const PRIVY_METHOD = { email: "email", google_oauth: "google", apple_oauth: "apple" } as const;
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
const out = (status: number, j: Record<string, unknown>) => NextResponse.json(j, { status, headers: { "cache-control": "no-store" } });

async function signedInUser(req: Request): Promise<PrivyUser | null> {
  const pe = privyEnv();
  const idt = req.headers.get("privy-id-token");
  if (idt && pe.appId) {
    const v = verifyIdentityToken(idt, await verificationKeys(pe), pe.appId);
    if (v) return v.user;
  }
  const a = await authenticate(bearer(req.headers), pe);
  return a.ok ? a.user : null;
}

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `xp:acct:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  let body: { address?: unknown };
  try { body = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  const addr = String(body?.address ?? "").toLowerCase();
  if (!isAddr(addr)) return out(400, { ok: false, reason: "Invalid address." });
  const user = await signedInUser(req);
  if (!user) return out(401, { ok: false, reason: "Sign in first." });
  if (!user.wallets.includes(addr)) return out(403, { ok: false, reason: "Sign in with the account that owns this wallet." });
  const pe = privyEnv();
  // fail open: a Privy lookup that fails counts as "gone" so nobody is locked out by an outage
  const dup = await duplicateLogin(user, async (did, email) => !!(await fetchPrivyUser(did, pe, undefined, undefined, true))?.emails.includes(email)).catch(() => null);
  if (dup) return out(409, { ok: false, duplicate: { method: PRIVY_METHOD[dup.method], join: PRIVY_METHOD[dup.join], email: dup.email }, reason: `This email is already on your ${LOGIN_LABEL[dup.method]} login.` });
  const r = await linkAccount(user);
  if (!r.ok) return out(409, r);
  if (r.joined.length) console.info("[xp account] linked", { account: r.account, joined: r.joined.length, wallets: r.wallets.length });
  return out(200, { ok: true, wallets: r.wallets.length, joined: r.joined.length });
}

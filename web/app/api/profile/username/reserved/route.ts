export const runtime = "nodejs";
/**
 * Bind the signed-in player's reserved username (lib/server/reservedNames, e.g. @maker) to the wallet they are using.
 * POST { address } with `Authorization: Bearer <Privy access token>` (or a `privy-id-token` header: verified locally,
 * no Privy users-API hop) → { ok: true, username: string | null, moved?: boolean }.
 *  - username null: this player owns no reserved name (the common case; nothing is written).
 *  - The wallet must be one of the Privy user's linked wallets (the embedded owner wallet is the account address).
 * Called once per sign-in by lib/profile syncLocalIdentity, so a reserved name can never be "forgotten" when a login
 * method lands on a different wallet, and sign-in never touches anyone else's username.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv, verificationKeys, verifyIdentityToken, type PrivyUser } from "@/lib/server/privyAuth";
import { reservedNameFor, reservedOwners } from "@/lib/server/reservedNames";
import { bindReserved } from "@/lib/server/usernames";

export const dynamic = "force-dynamic";
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
  // nothing reserved (no config) ⇒ nothing to do, no auth calls
  if (!reservedOwners().size) return out(200, { ok: true, username: null });
  const rl = await hitLimit(kv(), `user:reserved:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  let body: { address?: unknown };
  try { body = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  const addr = String(body?.address ?? "").toLowerCase();
  if (!isAddr(addr)) return out(400, { ok: false, reason: "Invalid address." });
  const user = await signedInUser(req);
  if (!user) return out(401, { ok: false, reason: "Sign in first." });
  const name = reservedNameFor(user.emails);
  if (!name) return out(200, { ok: true, username: null });
  if (!user.wallets.includes(addr)) return out(403, { ok: false, reason: "Sign in with the account that owns this wallet." });
  const r = await bindReserved(name, addr);
  if (r.moved) console.info("[username] reserved name bound", { name, to: addr, from: r.from });
  return out(200, { ok: true, username: name, moved: r.moved });
}

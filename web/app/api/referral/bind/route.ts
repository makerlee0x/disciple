export const runtime = "nodejs";
/**
 * POST /api/referral/bind { wallet, ref: { u, a, t } } — save the browser's first-touch referrer to the signed-in
 * account (lib/server/referralBind). Privy session (Authorization: Bearer <access token>), no wallet signature,
 * same auth as /api/invites. First write wins; never overwrites; self-referral is refused. Called once, in the
 * background, after sign-in (lib/referralBindClient); a failure never affects sign-in or trading.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { inviteDeps } from "@/lib/server/inviteGate";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { handleBind } from "@/lib/server/referralBind";

export const dynamic = "force-dynamic";
const out = (s: number, b: Record<string, unknown>) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `ref:bind:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return out(429, { ok: false, error: "rate_limited" });
  let body: unknown;
  try { body = await req.json(); } catch { return out(400, { ok: false, error: "bad_json" }); }
  try {
    const [s, b] = await handleBind(
      { store: kv(), authenticate: (t) => authenticate(t, privyEnv()), accountsOf: inviteDeps().accountsOf },
      bearer(req.headers),
      body,
    );
    return out(s, b);
  } catch (e) {
    console.warn("[referral-bind]", (e as Error).message);
    return out(500, { ok: false, error: "bind_failed" });
  }
}

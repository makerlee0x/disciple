export const runtime = "nodejs";
/**
 * Admin side of invite-only. Privy session whose linked email (email or Google login) is in ADMIN_EMAILS. No wallet
 * signature. ADMIN_EMAILS unset ⇒ 503 for everyone (fail closed).
 * GET  ?nonce=1 → { nonce } (single use per action, 10 min)
 * GET           → { me, mode, modeSource, envDefault, codes, waitlist, log }
 * POST { nonce, action: create{n} | admit{privyId} | topup{privyId, n} | revoke{code} | mode{mode: on|off|default} }
 */
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/limits";
import { bearer } from "@/lib/server/privyAuth";
import { adminAction, adminList, adminNonce } from "@/lib/server/invites";
import { inviteDeps } from "@/lib/server/inviteGate";

export const dynamic = "force-dynamic";
const out = ([s, b]: [number, Record<string, unknown>]) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const u = new URL(req.url), ip = clientIp(req.headers), t = bearer(req.headers);
  if (u.searchParams.get("nonce") !== null) return out(await adminNonce(inviteDeps(), t, ip));
  return out(await adminList(inviteDeps(), t, ip));
}
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return out([400, { error: "Bad JSON" }]); }
  if (!body || typeof body !== "object") return out([400, { error: "Bad JSON" }]);
  return out(await adminAction(inviteDeps(), bearer(req.headers), body, clientIp(req.headers)));
}

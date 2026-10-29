export const runtime = "nodejs";
/**
 * Player side of invite-only (lib/server/invites). Privy session (Authorization: Bearer <access token>), no wallet signature.
 * GET  → { mode, signedIn, in, admin, waitlisted, left, codes: [{ code, used }] }   (not signed in ⇒ { mode, signedIn: false })
 * POST { action: "redeem", code } → { ok, in } | { ok: false, error: bad_code|used|own_code|already_in|busy }
 * POST { action: "waitlist" }     → { ok, waitlisted }
 */
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/limits";
import { bearer } from "@/lib/server/privyAuth";
import { playerAction, playerStatus } from "@/lib/server/invites";
import { inviteDeps } from "@/lib/server/inviteGate";

export const dynamic = "force-dynamic";
const out = ([s, b]: [number, Record<string, unknown>]) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  return out(await playerStatus(inviteDeps(), bearer(req.headers), clientIp(req.headers)));
}
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return out([400, { error: "Bad JSON" }]); }
  if (!body || typeof body !== "object") return out([400, { error: "Bad JSON" }]);
  return out(await playerAction(inviteDeps(), bearer(req.headers), body, clientIp(req.headers)));
}

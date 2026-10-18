export const runtime = "nodejs";
/**
 * Admin review of verification requests. Privy session (Authorization: Bearer <access token>) whose linked email is in
 * ADMIN_EMAILS (comma-separated). ADMIN_EMAILS unset ⇒ 503 for everyone (fail closed).
 * GET  ?nonce=1               → { nonce } (single use per action, 10 min)
 * GET  ?status=pending|approved|rejected|revoked|all → { rows }
 * POST { token, action: approve|reject|revoke, nonce, reason? } → { ok, status }
 */
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/limits";
import { bearer } from "@/lib/server/privyAuth";
import { adminAction, adminList, adminNonce } from "@/lib/server/verification";
import { verifyDeps } from "@/lib/server/verifyDeps";

export const dynamic = "force-dynamic";
const out = ([s, b]: [number, Record<string, unknown>]) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const u = new URL(req.url), ip = clientIp(req.headers), t = bearer(req.headers);
  if (u.searchParams.get("nonce") !== null) return out(await adminNonce(verifyDeps(), t, ip));
  return out(await adminList(verifyDeps(), t, u.searchParams.get("status"), ip));
}
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return out([400, { error: "Bad JSON" }]); }
  if (!body || typeof body !== "object") return out([400, { error: "Bad JSON" }]);
  return out(await adminAction(verifyDeps(), bearer(req.headers), body, clientIp(req.headers)));
}

export const runtime = "nodejs";
/**
 * Creator verification requests (Privy session; Authorization: Bearer <privy access token>). lib/server/verification.
 * GET  ?nonce=1          → { nonce, ttlSec }  (single use, bound to the Privy user, 10 min)
 * GET  ?token=0x…        → { status | null, … } the caller's own request for that rocket
 * POST { token, x?, website?, note?, nonce } → { ok, status: "pending" }   (caller must be the on-chain creator)
 */
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/limits";
import { bearer } from "@/lib/server/privyAuth";
import { creatorNonce, creatorStatus, submitRequest } from "@/lib/server/verification";
import { verifyDeps } from "@/lib/server/verifyDeps";

export const dynamic = "force-dynamic";
const out = ([s, b]: [number, Record<string, unknown>]) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const u = new URL(req.url), ip = clientIp(req.headers), t = bearer(req.headers);
  if (u.searchParams.get("nonce") !== null) return out(await creatorNonce(verifyDeps(), t, ip));
  return out(await creatorStatus(verifyDeps(), t, u.searchParams.get("token") || "", ip));
}
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return out([400, { error: "Bad JSON" }]); }
  if (!body || typeof body !== "object") return out([400, { error: "Bad JSON" }]);
  return out(await submitRequest(verifyDeps(), bearer(req.headers), body, clientIp(req.headers)));
}

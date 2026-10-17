/**
 * GET  ?addr=0x… → { nonce, ttlSec }   single-use login nonce (Upstash, 5 min), included in the signed message.
 * POST { addr, ts, nonce, sig, owner? } → { token, exp, addr }. See lib/server/chat/identity.ts.
 */
import { NextResponse } from "next/server";
import { chatSecretConfigured, issueLoginNonce, issueToken, LOGIN_NONCE_TTL_SEC, verifyLogin } from "@/lib/server/chat/identity";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!chatSecretConfigured()) return NextResponse.json({ error: "chat_not_configured" }, { status: 503 });
  const addr = (new URL(req.url).searchParams.get("addr") || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return NextResponse.json({ error: "bad_address" }, { status: 400 });
  const rl = await hitLimit(kv(), `chat:nonce:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const nonce = await issueLoginNonce(addr);
  return NextResponse.json({ nonce, ttlSec: LOGIN_NONCE_TTL_SEC }, { headers: { "cache-control": "no-store" } });
}
export async function POST(req: Request) {
  if (!chatSecretConfigured()) return NextResponse.json({ error: "chat_not_configured" }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  const addr = await verifyLogin(body);
  if (!addr) return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  const t = issueToken(addr)!;
  return NextResponse.json({ ...t, addr });
}

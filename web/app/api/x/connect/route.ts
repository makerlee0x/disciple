export const runtime = "nodejs";
/**
 * Start linking an X account. POST { address, nonce, signature, owner?, returnTo? } → { ok, url } (send the browser to url).
 * Auth: single-use nonce from GET /api/x?nonce=1 + wallet signature over xConnectMessage (same pattern as profile meta).
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { consumeNonce, nonceValid } from "@/lib/server/nonces";
import { verifyWalletSignature } from "@/lib/server/chat/identity";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { X_NONCE_PREFIX, X_STATE_COOKIE, beginLink, xConfigured } from "@/lib/server/xLink";
import { xConnectMessage } from "@/lib/xLink";

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!xConfigured()) return NextResponse.json({ ok: false, reason: "X linking isn't available right now." }, { status: 503 });
  const rl = await hitLimit(kv(), `x:connect:ip:${clientIp(req.headers)}`, 10, 60);
  if (!rl.ok) return NextResponse.json({ ok: false, reason: "Too many requests, try again shortly." }, { status: 429 });
  let body: { address?: unknown; nonce?: unknown; signature?: unknown; owner?: unknown; returnTo?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const addr = String(body?.address ?? "").toLowerCase();
  if (!isAddr(addr)) return NextResponse.json({ ok: false, reason: "Invalid address." }, { status: 400 });
  const nonce = String(body.nonce ?? "");
  if (!(await nonceValid(kv(), X_NONCE_PREFIX, nonce, addr))) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  const owner = typeof body.owner === "string" ? body.owner : null;
  const who = await verifyWalletSignature(addr, xConnectMessage(addr, nonce), String(body.signature ?? ""), owner);
  if (who !== addr) return NextResponse.json({ ok: false, reason: "Signature didn't match this wallet." }, { status: 401 });
  if (!(await consumeNonce(kv(), X_NONCE_PREFIX, nonce, addr))) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  const origin = new URL(req.url).origin;
  const { url, state } = await beginLink(addr, origin, typeof body.returnTo === "string" ? body.returnTo : "/profile");
  const res = NextResponse.json({ ok: true, url }, { headers: { "cache-control": "no-store" } });
  // Lax so it rides along on X's top-level redirect back to the callback.
  res.cookies.set(X_STATE_COOKIE, state, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: "/api/x", maxAge: 600 });
  return res;
}

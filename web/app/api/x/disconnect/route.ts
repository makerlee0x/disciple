export const runtime = "nodejs";
/** Unlink X. POST { address, nonce, signature, owner? } → { ok } (nonce from GET /api/x?nonce=1, signs xDisconnectMessage). */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { consumeNonce, nonceValid } from "@/lib/server/nonces";
import { verifyWalletSignature } from "@/lib/server/chat/identity";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { X_NONCE_PREFIX, unlink } from "@/lib/server/xLink";
import { xDisconnectMessage } from "@/lib/xLink";

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `x:disconnect:ip:${clientIp(req.headers)}`, 10, 60);
  if (!rl.ok) return NextResponse.json({ ok: false, reason: "Too many requests, try again shortly." }, { status: 429 });
  let body: { address?: unknown; nonce?: unknown; signature?: unknown; owner?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const addr = String(body?.address ?? "").toLowerCase();
  if (!isAddr(addr)) return NextResponse.json({ ok: false, reason: "Invalid address." }, { status: 400 });
  const nonce = String(body.nonce ?? "");
  if (!(await nonceValid(kv(), X_NONCE_PREFIX, nonce, addr))) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  const owner = typeof body.owner === "string" ? body.owner : null;
  const who = await verifyWalletSignature(addr, xDisconnectMessage(addr, nonce), String(body.signature ?? ""), owner);
  if (who !== addr) return NextResponse.json({ ok: false, reason: "Signature didn't match this wallet." }, { status: 401 });
  if (!(await consumeNonce(kv(), X_NONCE_PREFIX, nonce, addr))) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  await unlink(addr);
  return NextResponse.json({ ok: true });
}

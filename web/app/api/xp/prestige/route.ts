export const runtime = "nodejs";
/** Prestige at level 50. POST { address, nonce, signature, owner? } → { ok, prestige } | { ok: false, reason }. */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { prestigeUp } from "@/lib/server/xp";
import { verifySigned, type SignedBody } from "@/lib/server/xpAuth";
import { prestigeMessage } from "@/lib/xp";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `xp:prestige:ip:${clientIp(req.headers)}`, 10, 60);
  if (!rl.ok) return NextResponse.json({ ok: false, reason: "Too many requests, try again shortly." }, { status: 429 });
  let body: SignedBody;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const v = await verifySigned(body, prestigeMessage);
  if (!v.ok) return NextResponse.json({ ok: false, reason: v.reason }, { status: v.status });
  const r = await prestigeUp(v.wallet);
  return NextResponse.json(r, { status: r.ok ? 200 : 409, headers: { "cache-control": "no-store" } });
}

export const runtime = "nodejs";
/**
 * Unlock a Rocket Factory part with XP. POST { address, nonce, signature, owner?, part } → { ok, part, spendableXp } | { ok: false, reason }.
 * Auth: nonce from GET /api/xp?nonce=1&address + wallet signature over shopBuyMessage. Price, prestige lock and balance
 * are checked server side (lib/server/xp.ts buyPart) against the catalogue in lib/parts.ts.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { buyPart } from "@/lib/server/xp";
import { verifySigned, type SignedBody } from "@/lib/server/xpAuth";
import { shopBuyMessage } from "@/lib/xp";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `shop:buy:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return NextResponse.json({ ok: false, reason: "Too many requests, try again shortly." }, { status: 429 });
  let body: SignedBody & { part?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const part = typeof body?.part === "string" && /^[a-z0-9-]{1,40}$/.test(body.part) ? body.part : "";
  if (!part) return NextResponse.json({ ok: false, reason: "Pick a part." }, { status: 400 });
  const v = await verifySigned(body, (a, n) => shopBuyMessage(a, part, n));
  if (!v.ok) return NextResponse.json({ ok: false, reason: v.reason }, { status: v.status });
  const r = await buyPart(v.wallet, part);
  return NextResponse.json(r, { status: r.ok ? 200 : 409, headers: { "cache-control": "no-store" } });
}

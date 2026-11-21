/** POST { coin, id, reason? } + Authorization: Bearer <chat token> → { ok, hidden } (lib/server/chat/moderation). */
import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/server/chat/identity";
import { reportMessage } from "@/lib/server/chat/moderation";
import { isCoin } from "@/lib/chat/types";
import { kv } from "@/lib/server/kv";
import { hitLimit } from "@/lib/server/limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const j = (b: Record<string, unknown>, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
export async function POST(req: Request) {
  const tok = verifyToken((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!tok) return j({ ok: false, error: "Sign in to report." }, 401);
  const rl = await hitLimit(kv(), `chatreport:${tok.a}`, 20, 3600);
  if (!rl.ok) return j({ ok: false, error: "You've sent a lot of reports. Try again later." }, 429);
  const b = (await req.json().catch(() => ({}))) as { coin?: string; id?: string; reason?: string };
  const coin = String(b.coin || "").toLowerCase(), id = String(b.id || "");
  if (!isCoin(coin) || !/^[0-9A-Z]{26}$/.test(id)) return j({ ok: false, error: "Bad request." }, 400);
  const r = await reportMessage(coin, id, tok.a, String(b.reason || "other"));
  return r.ok ? j(r) : j({ ok: false, error: r.error }, r.status);
}

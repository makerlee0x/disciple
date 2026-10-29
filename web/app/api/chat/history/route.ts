/** GET ?coin=0x…&limit=50&before=<ulid> → { messages: ChatMsg[] } oldest→newest. */
import { NextResponse } from "next/server";
import { historyOf } from "@/lib/server/chat/store";
import { isCoin } from "@/lib/chat/types";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `chatread:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.chatReadPerIp.limit, PUBLIC_GET_LIMITS.chatReadPerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const u = new URL(req.url);
  const coin = (u.searchParams.get("coin") || "").toLowerCase();
  if (!isCoin(coin)) return NextResponse.json({ error: "bad_coin" }, { status: 400 });
  const limit = Number(u.searchParams.get("limit") || 50) || 50;
  const before = u.searchParams.get("before") || undefined;
  return NextResponse.json({ messages: await historyOf(coin, limit, before) }, { headers: { "cache-control": "no-store" } });
}

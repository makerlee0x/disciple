/** GET ?coin=0x…&limit=50&before=<ulid> → { messages: ChatMsg[] } oldest→newest. */
import { NextResponse } from "next/server";
import { historyOf } from "@/lib/server/chat/store";
import { isCoin } from "@/lib/chat/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const u = new URL(req.url);
  const coin = (u.searchParams.get("coin") || "").toLowerCase();
  if (!isCoin(coin)) return NextResponse.json({ error: "bad_coin" }, { status: 400 });
  const limit = Number(u.searchParams.get("limit") || 50) || 50;
  const before = u.searchParams.get("before") || undefined;
  return NextResponse.json({ messages: await historyOf(coin, limit, before) }, { headers: { "cache-control": "no-store" } });
}

/** GET /api/leaderboard?window=day|week|month|all&sort=pnl|pctGain|volume|holdTime[&me=0x…] → lib/server/leaderboard BoardResponse. */
import { NextResponse } from "next/server";
import { getLeaderboard } from "@/lib/server/leaderboard";
import { BOARD_SORTS, BOARD_WINDOWS, type BoardSort, type BoardWindow } from "@/lib/home/topPilots";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `lboard:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.homePerIp.limit, PUBLIC_GET_LIMITS.homePerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const q = new URL(req.url).searchParams;
  const window = (q.get("window") ?? "day") as BoardWindow;
  const sort = (q.get("sort") ?? "pnl") as BoardSort;
  const me = q.get("me");
  if (!BOARD_WINDOWS.some((w) => w.k === window) || !BOARD_SORTS.includes(sort)) return NextResponse.json({ error: "bad query" }, { status: 400 });
  if (me !== null && !/^0x[0-9a-fA-F]{40}$/.test(me)) return NextResponse.json({ error: "bad me" }, { status: 400 });
  const data = await getLeaderboard(window, sort, me);
  return NextResponse.json(data, { headers: { "cache-control": me ? "private, max-age=0" : "public, max-age=0, s-maxage=15, stale-while-revalidate=30" } });
}

/** GET /api/leaderboard?window=day|week|month|all&sort=pnl|pctGain|orbits|crews|positions|overall|lifetime|weekly|royale|climb[&me=0x…] (sort=pairs&by=score|volume|burned|rockets|traders: lib/server/pairBoard) → lib/server/leaderboard BoardResponse (CrewBoardResponse for crews). */
import { NextResponse } from "next/server";
import { getCrewBoard, getLeaderboard, getLifetime, getModeBoard, getOverall, getPositions, getWeekly } from "@/lib/server/leaderboard";
import { BOARD_SORTS, BOARD_WINDOWS, type BoardSort, type BoardWindow } from "@/lib/home/topPilots";
import { kv } from "@/lib/server/kv";
import { getPairBoard } from "@/lib/server/pairBoard";
import { PAIR_SORTS, type PairSort } from "@/lib/home/pairBoard";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `lboard:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.homePerIp.limit, PUBLIC_GET_LIMITS.homePerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const q = new URL(req.url).searchParams;
  const window = (q.get("window") ?? "day") as BoardWindow;
  const sort = (q.get("sort") ?? "pnl") as BoardSort | "crews" | "positions" | "overall" | "lifetime" | "weekly" | "royale" | "climb";
  const me = q.get("me");
  if (q.get("sort") === "pairs") {
    const by = (q.get("by") ?? "score") as PairSort;
    if (!PAIR_SORTS.includes(by)) return NextResponse.json({ error: "bad query" }, { status: 400 });
    // the board is a KV snapshot refreshed in the background (lib/server/pairBoard), so the edge can hold it longer
    return NextResponse.json(await getPairBoard(by), { headers: { "cache-control": "public, max-age=0, s-maxage=30, stale-while-revalidate=600" } });
  }
  if (!BOARD_WINDOWS.some((w) => w.k === window) || (!["crews", "positions", "overall", "lifetime", "weekly", "royale", "climb"].includes(sort) && !BOARD_SORTS.includes(sort as BoardSort))) return NextResponse.json({ error: "bad query" }, { status: 400 });
  if (me !== null && !/^0x[0-9a-fA-F]{40}$/.test(me)) return NextResponse.json({ error: "bad me" }, { status: 400 });
  const data = sort === "overall" ? await getOverall(me) : sort === "weekly" ? await getWeekly(me) : sort === "lifetime" ? await getLifetime(me) : sort === "royale" || sort === "climb" ? await getModeBoard(sort) : sort === "positions" ? await getPositions(window) : sort === "crews" ? await getCrewBoard(window, me) : await getLeaderboard(window, sort, me);
  return NextResponse.json(data, { headers: { "cache-control": me ? "private, max-age=0" : "public, max-age=0, s-maxage=15, stale-while-revalidate=30" } });
}

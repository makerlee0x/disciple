/** GET /api/profile/pilot-stats?wallet=0x… → lib/server/pilotStats PilotStats: ranks in every mode + career numbers for the stats page. Public. */
import { NextResponse } from "next/server";
import { pilotStats } from "@/lib/server/pilotStats";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `pstats:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.homePerIp.limit, PUBLIC_GET_LIMITS.homePerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  try {
    return NextResponse.json(await pilotStats(wallet), { headers: { "cache-control": "public, max-age=15, s-maxage=60, stale-while-revalidate=120" } });
  } catch (e) {
    console.warn("[disciple] pilot stats route failed", (e as Error).message);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

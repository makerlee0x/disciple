/**
 * GET /api/turbo/profile?wallet=0x… → lib/server/turboProfile TurboProfile: duel record, recent duels, Climb, real Turbo
 * fills and PnL for the Turbo page. Public, like the boards. fra1 with the other Lighter routes (app/api/lighter).
 */
import { NextResponse } from "next/server";
import { turboProfile } from "@/lib/server/turboProfile";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "fra1";
export const maxDuration = 30;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `tprof:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.homePerIp.limit, PUBLIC_GET_LIMITS.homePerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  try {
    return NextResponse.json(await turboProfile(wallet), { headers: { "cache-control": "public, max-age=15, s-maxage=45, stale-while-revalidate=90" } });
  } catch (e) {
    console.warn("[turbo profile] route failed", (e as Error).message);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

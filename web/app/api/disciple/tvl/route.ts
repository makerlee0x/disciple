/**
 * GET /api/disciple/tvl?pool=0x… → DiscipleHook TVL from poolState (+ ERC-6909 claims).
 * Unknown pool ids (including AscensionHook graduation pools) are 404. This route does not call getLiquidity.
 */
import { NextResponse } from "next/server";
import { isDisciplePoolId } from "@/lib/disciple/catalog";
import { readDiscipleTvl } from "@/lib/server/discipleTvl";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { kv } from "@/lib/server/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;
const PER_IP = { limit: 60, windowSec: 60 };

export async function GET(req: Request) {
  const pool = new URL(req.url).searchParams.get("pool");
  if (!pool || !/^0x[0-9a-fA-F]{64}$/.test(pool)) return NextResponse.json({ error: "bad pool" }, { status: 400 });
  if (!isDisciplePoolId(pool)) return NextResponse.json({ error: "not a disciple pool" }, { status: 404 });
  const rl = await hitLimit(kv(), `dtvrl:${clientIp(req.headers)}`, PER_IP.limit, PER_IP.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  try {
    const tvl = await readDiscipleTvl(pool);
    if (!tvl) return NextResponse.json({ error: "not a disciple pool" }, { status: 404 });
    return NextResponse.json(tvl, { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" } });
  } catch (e) {
    console.warn("[disciple tvl]", (e as Error).message);
    return NextResponse.json({ error: "tvl unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

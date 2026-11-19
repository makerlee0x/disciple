/**
 * GET /api/coin/stats?coin=0x… → CoinStats (lib/coinStats): mcap, price, 24H change, 24H volume, liquidity, holders, for the
 * coin page stats strip. Rate-limited per IP; short shared cache.
 */
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { isAddr } from "@/lib/holders";
import { coinStats } from "@/lib/server/coinStats";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { kv } from "@/lib/server/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;
const PER_IP = { limit: 30, windowSec: 60 };

export async function GET(req: Request) {
  const coin = new URL(req.url).searchParams.get("coin");
  if (!isAddr(coin)) return NextResponse.json({ error: "bad coin" }, { status: 400 });
  const rl = await hitLimit(kv(), `coinstats:${clientIp(req.headers)}`, PER_IP.limit, PER_IP.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  try {
    const s = await coinStats(coin as Address);
    return NextResponse.json(s, { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "unknown coin") return NextResponse.json({ error: "unknown coin" }, { status: 404 });
    console.warn("[coinstats]", msg);
    return NextResponse.json({ error: "stats unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

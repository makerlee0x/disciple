/**
 * GET /api/coin/grad?coin=0x… → { coin, graduated: boolean, poolId: bytes32 hex | null, graduatedAt: unix seconds | null }
 * (lib/protocol GradState; lib/server/grad). DiscipleFeed stamps it on every engine update. Rate-limited per IP; a
 * graduated answer is immutable ⇒ long shared cache, otherwise a short one.
 */
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { isAddr } from "@/lib/holders";
import { gradInfo } from "@/lib/server/grad";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { kv } from "@/lib/server/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;
const PER_IP = { limit: 60, windowSec: 60 };

export async function GET(req: Request) {
  const coin = new URL(req.url).searchParams.get("coin");
  if (!isAddr(coin)) return NextResponse.json({ error: "bad coin" }, { status: 400 });
  const rl = await hitLimit(kv(), `gradrl:${clientIp(req.headers)}`, PER_IP.limit, PER_IP.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  try {
    const g = await gradInfo(coin as Address);
    const done = g.graduated && g.poolId && g.graduatedAt;
    return NextResponse.json({ coin: coin.toLowerCase(), ...g }, { headers: { "Cache-Control": done ? "public, s-maxage=86400, stale-while-revalidate=86400" : "public, s-maxage=5, stale-while-revalidate=15" } });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "unknown coin") return NextResponse.json({ error: "unknown coin" }, { status: 404 });
    console.warn("[grad]", msg);
    return NextResponse.json({ error: "grad unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

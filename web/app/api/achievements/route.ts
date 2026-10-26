/**
 * GET /api/achievements?wallet=0x… → V1 achievements of one trading account (Trade.trader: the smart account for router
 * trades). Public, KV-only (no RPC, no scoring — the cron scores), cached 30 s at the edge.
 * Body: { wallet, chainId, rulesVersion, evaluatedAt: ms|null, items: [{ id, name, rarity, unlockedAt?, tx?, block?,
 *   logIndex?, coin?, progress, target }] } — one item per V1 rule (lib/achievements.ts V1_RULES), unlocked or not.
 * evaluatedAt null = the engine hasn't scored this wallet yet (no trades, or the first backfill is still running).
 */
import { NextResponse } from "next/server";
import { achievementsOf } from "@/lib/server/achievements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ error: "wallet=0x… required" }, { status: 400 });
  try {
    return NextResponse.json(await achievementsOf(wallet), { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

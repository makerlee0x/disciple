/**
 * GET /api/achievements/feed?since=<ms>[&wallet=0x…] → { now, items: [{ wallet, id, name, rarity, unlockedAt, tx,
 * recordedAt }] } — LIVE unlocks the engine recorded after `since` (recordedAt, ms), oldest first, ≤ 100. For GAME's
 * unlock toasts (poll with since = the previous response's `now`). Backfilled unlocks (event older than 15 min when first
 * recorded) never appear here, so a backfill doesn't toast. Public, KV-only, not cached.
 */
import { NextResponse } from "next/server";
import { feedSince } from "@/lib/server/achievements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const now = Date.now();
  const since = Number(u.searchParams.get("since"));
  const wallet = u.searchParams.get("wallet");
  if (wallet !== null && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  try {
    const items = await feedSince(Number.isFinite(since) && since > 0 ? since : now - 60_000, wallet);
    return NextResponse.json({ now, items }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

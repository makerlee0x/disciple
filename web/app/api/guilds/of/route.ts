export const runtime = "nodejs";
/**
 * Batch guild tags for display: GET /api/guilds/of?w=0xa,0xb (≤ 100) → { guilds: { <wallet lc>: { id, tag, mark } | null } }.
 * Used by lib/guildLookup (wallet chip, leaderboard, profile header, home feed) and for GAME's feeds via window.__discipleGuilds.
 */
import { NextResponse } from "next/server";
import { guildTagsOf } from "@/lib/server/guilds";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { kv } from "@/lib/server/kv";

export const dynamic = "force-dynamic";
const MAX = 100;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `guild:of:${clientIp(req.headers)}`, 120, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const ws = (new URL(req.url).searchParams.get("w") || "").split(",").map((s) => s.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (ws.length > MAX) return NextResponse.json({ error: `max ${MAX} wallets` }, { status: 400 });
  return NextResponse.json({ guilds: await guildTagsOf(ws) }, { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } });
}

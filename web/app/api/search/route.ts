/**
 * GET /api/search?q= → SearchResult { q, pilots, rockets, items } (lib/server/search). The top bar search (components/search/SiteSearch)
 * calls it as the player types (debounced). Under SEARCH_MIN chars (and not a 0x address) every group comes back empty.
 */
import { NextResponse } from "next/server";
import { normQuery } from "@/lib/search";
import { siteSearch } from "@/lib/server/search";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `search:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.searchPerIp.limit, PUBLIC_GET_LIMITS.searchPerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const q = normQuery(new URL(req.url).searchParams.get("q"));
  const res = await siteSearch(q);
  return NextResponse.json(res, { headers: { "cache-control": "public, max-age=0, s-maxage=20, stale-while-revalidate=60" } });
}

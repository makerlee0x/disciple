export const runtime = "nodejs";
/**
 * GET /api/verified?tokens=0x…,0x… (≤100) → { verified: { <token>: true } } — approved rockets only (admin-reviewed;
 * lib/server/verification). Cached: 15 s in-process + CDN s-maxage=30. Rate limited per IP.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { LIMITS, verifiedMap } from "@/lib/server/verification";

export const dynamic = "force-dynamic";
const cache = new Map<string, { at: number; v: Record<string, true> }>();

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `verified:ip:${clientIp(req.headers)}`, LIMITS.publicPerIp.limit, LIMITS.publicPerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const raw = (new URL(req.url).searchParams.get("tokens") || "").slice(0, 100 * 43);
  const tokens = raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)).sort();
  const key = tokens.join(",");
  const hit = cache.get(key);
  let v: Record<string, true>;
  if (hit && Date.now() - hit.at < 15_000) v = hit.v;
  else {
    v = await verifiedMap(kv(), tokens).catch(() => ({}));
    if (cache.size > 2000) cache.clear();
    cache.set(key, { at: Date.now(), v });
  }
  return NextResponse.json({ verified: v }, { headers: { "cache-control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120" } });
}

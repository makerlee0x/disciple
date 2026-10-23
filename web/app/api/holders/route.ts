/**
 * GET /api/holders?coin=0x…&limit=50 (1–100) → { coin, holders: [{ address, balance (raw string), pct (% of supply),
 * usd (at current mcap), label: 'pool'|'curve'|'locker'|null }], asOfBlock } sorted by balance desc.
 * Indexed from the coin's ERC-20 Transfer logs (lib/server/holders). Rate-limited per IP; short shared cache.
 */
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { clampHoldersLimit, isAddr } from "@/lib/holders";
import { holdersOf } from "@/lib/server/holders";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { kv } from "@/lib/server/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;
const PER_IP = { limit: 60, windowSec: 60 };

export async function GET(req: Request) {
  const u = new URL(req.url);
  const coin = u.searchParams.get("coin");
  if (!isAddr(coin)) return NextResponse.json({ error: "bad coin" }, { status: 400 });
  const rl = await hitLimit(kv(), `holders:${clientIp(req.headers)}`, PER_IP.limit, PER_IP.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  try {
    const r = await holdersOf(coin as Address, clampHoldersLimit(u.searchParams.get("limit")));
    return NextResponse.json({ coin: coin.toLowerCase(), ...r }, { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=15" } });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "unknown coin") return NextResponse.json({ error: "unknown coin" }, { status: 404 });
    console.warn("[holders]", msg);
    return NextResponse.json({ error: "holders unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

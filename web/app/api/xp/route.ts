export const runtime = "nodejs";
/**
 * XP and missions (lib/xp.ts has the rules, lib/server/xp.ts the ledger).
 * GET ?wallet=0x…           → XpSummary: level, total XP, XP to spend, today's and this week's missions, owned parts
 * GET ?nonce=1&address=0x…  → { nonce, ttlSec }   (signed for POST /api/shop/buy or POST /api/xp/prestige)
 * KV only; the achievements cron does the scoring.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { issueNonce } from "@/lib/server/nonces";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { XP_NONCE_PREFIX, xpSummary } from "@/lib/server/xp";

export const dynamic = "force-dynamic";
const NONCE_TTL = 600;
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("nonce") !== null) {
    const address = (url.searchParams.get("address") || "").toLowerCase();
    if (!isAddr(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
    const rl = await hitLimit(kv(), `xp:nonce:ip:${clientIp(req.headers)}`, 30, 60);
    if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
    const nonce = await issueNonce(kv(), XP_NONCE_PREFIX, address, NONCE_TTL);
    return NextResponse.json({ nonce, ttlSec: NONCE_TTL }, { headers: { "cache-control": "no-store" } });
  }
  const wallet = (url.searchParams.get("wallet") || "").toLowerCase();
  if (!isAddr(wallet)) return NextResponse.json({ error: "wallet=0x… required" }, { status: 400 });
  try {
    return NextResponse.json(await xpSummary(wallet), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

/**
 * GET /api/name-lock?name=&ticker= → { enforced, available, reason?, holder? }
 * GET /api/name-lock?coin=0x…     → { enforced, copy, holder? }
 *
 * Mainnet only: testnet always returns enforced: false (available / not a copy).
 * The launch form checks this before sending a launch. Off-chain only: a direct
 * contract call cannot be stopped; slipped-in copies are hidden/flagged on the site.
 */
import { NextResponse } from "next/server";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { isAddr } from "@/lib/holders";
import { checkNameTicker, copyStatus } from "@/lib/server/nameLock";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tooMany = (retry: number) =>
  NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(retry) } });

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `namelock:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.nameLockPerIp.limit, PUBLIC_GET_LIMITS.nameLockPerIp.windowSec);
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  const url = new URL(req.url);
  const coin = url.searchParams.get("coin");
  if (coin !== null) {
    if (!isAddr(coin)) return NextResponse.json({ error: "bad coin" }, { status: 400 });
    const r = await copyStatus(coin, ACTIVE_CHAIN.id);
    return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
  }
  const name = url.searchParams.get("name");
  const ticker = url.searchParams.get("ticker");
  if (name === null || ticker === null) return NextResponse.json({ error: "name and ticker required" }, { status: 400 });
  const r = await checkNameTicker(name, ticker, ACTIVE_CHAIN.id);
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
}

export const runtime = "nodejs";
/**
 * X account link status (lib/xLink.ts has the flow).
 * GET ?address=0x…          → { enabled, link: { id, username, linkedAt } | null }
 * GET ?nonce=1&address=0x…  → { nonce, ttlSec }   (signed by the wallet for /api/x/connect or /api/x/disconnect)
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { issueNonce } from "@/lib/server/nonces";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { X_NONCE_PREFIX, linkOf, xConfigured } from "@/lib/server/xLink";


const NONCE_TTL = 600;
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = (url.searchParams.get("address") || "").toLowerCase();
  if (!isAddr(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
  if (url.searchParams.get("nonce") !== null) {
    const rl = await hitLimit(kv(), `x:nonce:ip:${clientIp(req.headers)}`, 30, 60);
    if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
    const nonce = await issueNonce(kv(), X_NONCE_PREFIX, address, NONCE_TTL);
    return NextResponse.json({ nonce, ttlSec: NONCE_TTL }, { headers: { "cache-control": "no-store" } });
  }
  const link = await linkOf(address).catch(() => null);
  return NextResponse.json({ enabled: xConfigured(), link }, { headers: { "cache-control": "no-store" } });
}

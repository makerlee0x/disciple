/**
 * Host mission control (main mode hook loop, maker 2026-11-13). GET ?coin=0x… → HostView (lib/server/host): passengers,
 * crews aboard, top-10 share, passengers over time, milestones, and the host's rockets. Public: every number comes from
 * on-chain trades and holders, and counts people and zones only.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { hostFor } from "@/lib/server/host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `host:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const coin = (new URL(req.url).searchParams.get("coin") || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(coin)) return NextResponse.json({ error: "coin=0x… required" }, { status: 400 });
  const h = await hostFor(coin).catch(() => null);
  if (!h) return NextResponse.json({ error: "Rocket not found" }, { status: 404 });
  return NextResponse.json(h, { headers: { "cache-control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60" } });
}

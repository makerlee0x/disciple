/**
 * POST /api/daily/start {id, device} → { seed, ticket, already }: today's Daily flight seed (secret until a run starts) and a
 * start ticket signed for this device. POST /api/daily only scores a run with its ticket, at least a flight's length later.
 * already: this device has flown today's daily (the seed is for practice; the result is on the board).
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { startDaily } from "@/lib/server/daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  const rl = await hitLimit(kv(), `daily:start:${ip}`, 30, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  let body: { id?: unknown; device?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const r = await startDaily(Number(body?.id), body?.device, ip);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ seed: r.seed, ticket: r.ticket, already: r.already }, { headers: { "cache-control": "no-store" } });
}

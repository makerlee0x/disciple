/**
 * "Fly with me" landing (main mode hook loop, maker 2026-11-13). GET ?u=<username|0x…>&c=<ticker|0x…> → the inviter's
 * name, the rocket, and how many of the inviter's crew are aboard. Never when anyone boarded or what they paid.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { resolveFly } from "@/lib/server/fly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `fly:ip:${clientIp(req.headers)}`, 60, 60);
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const q = new URL(req.url).searchParams;
  const r = await resolveFly(q.get("u") || "", q.get("c") || "").catch(() => null);
  if (!r) return NextResponse.json({ error: "That invite link doesn't match a rocket" }, { status: 404 });
  return NextResponse.json(r.view, { headers: { "cache-control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60" } });
}

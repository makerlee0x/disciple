/**
 * Duel buzzer, run in fra1 (Lighter refuses signed txs from US IPs; duel routes run in iad1). Called by
 * lib/server/duel/store when a duel settles. Auth: Bearer CRON_SECRET. Body { id, pids }.
 * GET is the Vercel cron (vercel.json, every minute): the backup buzzer for any armed match past its end (sweepArmed).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { buzzer, sweepArmed } from "@/lib/server/lighter/match";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "fra1";
export const maxDuration = 60;

const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export async function POST(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s || !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { id?: unknown; pids?: unknown } | null;
  const id = typeof b?.id === "string" ? b.id : "";
  const pids = Array.isArray(b?.pids) ? b.pids.filter((p): p is string => typeof p === "string").slice(0, 8) : [];
  if (!id || !pids.length) return NextResponse.json({ ok: false }, { status: 400 });
  await Promise.all(pids.map((pid) => buzzer(pid, id).catch((e) => console.error("[lighter] buzz", e))));
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s || !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ ok: false }, { status: 401 });
  try { return NextResponse.json({ ok: true, ...(await sweepArmed()) }); }
  catch (e) { console.error("[lighter] sweep", e); return NextResponse.json({ ok: false }, { status: 500 }); }
}

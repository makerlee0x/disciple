/**
 * GET /api/cron/push: finds orbit, host milestone and crew zone events and sends the pushes (lib/server/pushEvents).
 * Scheduled in vercel.json every 5 minutes. Does nothing until VAPID keys are set. Auth: Bearer CRON_SECRET
 * (constant-time); in production an unset CRON_SECRET ⇒ 503.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { kv } from "@/lib/server/kv";
import { pushConfigured } from "@/lib/server/push";
import { runPushEvents } from "@/lib/server/pushEvents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!pushConfigured()) return NextResponse.json({ ok: true, skipped: "push_not_configured" }, { headers: NO_STORE });
  if (!(await kv().setNX("push:cron:lock", "1", 55))) return NextResponse.json({ ok: true, skipped: "locked" }, { headers: NO_STORE });
  try {
    return NextResponse.json(await runPushEvents(45_000), { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500, headers: NO_STORE });
  } finally {
    await kv().del("push:cron:lock").catch(() => {});
  }
}

/**
 * GET /api/cron/live-activity: keeps the iPhone app's lock-screen flights current while the app is closed
 * (lib/server/liveActivity). Scheduled in vercel.json every minute. Does nothing until the APNS_* keys are set.
 * Auth: Bearer CRON_SECRET (constant-time); in production an unset CRON_SECRET ⇒ 503.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { kv } from "@/lib/server/kv";
import { appPushConfigured } from "@/lib/server/push";
import { runLiveActivities } from "@/lib/server/liveActivity";
import { pnlForPosition } from "@/lib/server/share/pnl";

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
  if (!appPushConfigured()) return NextResponse.json({ ok: true, skipped: "apns_not_configured" }, { headers: NO_STORE });
  if (!(await kv().setNX("la:cron:lock", "1", 55))) return NextResponse.json({ ok: true, skipped: "locked" }, { headers: NO_STORE });
  try {
    return NextResponse.json(await runLiveActivities((w, c) => pnlForPosition(w, c), 40_000), { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500, headers: NO_STORE });
  } finally {
    await kv().del("la:cron:lock").catch(() => {});
  }
}

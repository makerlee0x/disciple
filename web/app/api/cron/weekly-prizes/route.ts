/**
 * GET /api/cron/weekly-prizes[?dry=1]: pays last week's board (lib/season/weekly WEEK_PRIZES) as collection crates.
 * OFF unless the server sets WEEKLY_PRIZES=1 (a proposal until maker picks the prizes, docs/proposals/weekly-prizes.md).
 * Reads the sealed final standings (lib/server/leaderboard weekFinal); grantCrate is once per (week, wallet), so hourly
 * runs are safe. Auth: Bearer CRON_SECRET (constant-time); in production an unset CRON_SECRET ⇒ 503.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { kv } from "@/lib/server/kv";
import { weekFinal } from "@/lib/server/leaderboard";
import { grantCrate } from "@/lib/server/collection";
import { lastWeekAt, prizeFor } from "@/lib/season/weekly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const NO_STORE = { "Cache-Control": "no-store" };
const on = () => process.env.WEEKLY_PRIZES === "1" || process.env.WEEKLY_PRIZES === "true";

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  if (!on() && !dry) return NextResponse.json({ ok: true, skipped: "off" }, { headers: NO_STORE });
  const prev = lastWeekAt(Date.now());
  const rows = await weekFinal(prev);
  if (!rows) return NextResponse.json({ ok: true, skipped: "settling", week: prev.id }, { headers: NO_STORE });
  if (!dry && !(await kv().setNX("week:prizes:lock", "1", 50))) return NextResponse.json({ ok: true, skipped: "locked" }, { headers: NO_STORE });
  const day = new Date(prev.startsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const paid: { rank: number; wallet: string; crate: string; given: boolean }[] = [];
  for (const r of rows) {
    const crate = prizeFor(r.rank); if (!crate || !(r.pts > 0)) continue;
    const given = dry ? false : await grantCrate(r.wallet, crate, `weekly:${prev.id}`, `Week of ${day} · #${r.rank}`).catch(() => false);
    paid.push({ rank: r.rank, wallet: r.wallet, crate, given });
  }
  return NextResponse.json({ ok: true, week: prev.id, dry, paid }, { headers: NO_STORE });
}

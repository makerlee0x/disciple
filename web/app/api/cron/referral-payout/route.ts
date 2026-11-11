/**
 * GET /api/cron/referral-payout?date=YYYY-MM-DD[&kind=summary|detail] — read-only daily referral
 * payout CSV for lee to send by hand (flow/referral-ledger). Not scheduled in vercel.json; not an
 * automatic payout. Drains any still-dirty fills first (same after-the-fact path as the trade
 * indexer), then returns one of the two CSVs (America/Chicago day boundary).
 * Auth: Bearer CRON_SECRET (constant-time), same as /api/cron/reindex-trades and /api/cron/achievements.
 * In production an unset CRON_SECRET ⇒ 503 (never an open endpoint).
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { payoutCsvForDate, previousChicagoDate, processReferralDirty } from "@/lib/server/referralLedger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const date = (u.searchParams.get("date") || previousChicagoDate()).trim();
  if (!DATE_RE.test(date)) return NextResponse.json({ error: "date=YYYY-MM-DD required" }, { status: 400 });
  const kind = (u.searchParams.get("kind") || "summary").trim();
  if (kind !== "summary" && kind !== "detail") return NextResponse.json({ error: "kind=summary|detail" }, { status: 400 });
  try {
    const drained = await processReferralDirty();
    const csv = await payoutCsvForDate(date);
    const body = kind === "detail" ? csv.detail : csv.summary;
    const filename = `referral-payout-${date}${kind === "detail" ? "-detail" : ""}.csv`;
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Referral-Drained-Recorded": String(drained.recorded),
        "X-Referral-Referrers": String(csv.referrers),
        "X-Referral-Rows": String(csv.rows),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

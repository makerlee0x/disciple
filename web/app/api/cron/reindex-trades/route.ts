/**
 * GET /api/cron/reindex-trades?coin=0x…|all[&dry=1] — one-off maintenance (SITE job 7), NOT scheduled in vercel.json.
 * Re-values stored /api/trades fills indexed with the old tokens × mid-price estimate (lib/server/trades reindexFills):
 * usd = Trade.quoteAmt × the coin's launch quote price. Idempotent; scoped to one coin or all; `dry=1` writes nothing.
 * Also the backfill for stored-fill schema bumps (lib/trades FILL_V): v2 = usdIn net of the router's UsdgRefund, v3 = +
 * impactBps / priceBeforeX18 / snipeFee. Every fill below FILL_V is rebuilt once from its receipt; each rebuilt fill marks
 * its wallet dirty for /api/cron/achievements. Run `?coin=all&dry=1` first and check the samples (usdInBefore/After).
 * Stops at a 45 s budget — `done: false` in the response ⇒ call again (already-revalued fills are skipped).
 * Auth: Bearer CRON_SECRET (constant-time). In production an unset CRON_SECRET ⇒ 503 (never an open endpoint).
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { reindexFills } from "@/lib/server/trades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const coin = (u.searchParams.get("coin") || "").trim();
  if (coin !== "all" && !/^0x[0-9a-fA-F]{40}$/.test(coin)) return NextResponse.json({ error: "coin=0x… or coin=all required" }, { status: 400 });
  const dryRun = u.searchParams.get("dry") === "1";
  try {
    const r = await reindexFills(coin === "all" ? "all" : { coin }, { dryRun, budgetMs: 45_000 });
    return NextResponse.json({ ok: true, scope: coin.toLowerCase(), ...r }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
}

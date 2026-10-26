/**
 * GET /api/cron/achievements[?wallet=0x…][&dry=1] — V1 achievements engine tick (lib/server/achievements.ts).
 * Scheduled in vercel.json (see the PR note: needs lee's OK for the schedule / Upstash command volume).
 *  - default: trade index catch-up → Launched/GraduatedToV4 scan → seed all wallets once per rules version (backfill) →
 *    re-score dirty wallets. 45 s budget; `done: false` ⇒ more work queued (the next tick continues).
 *  - wallet=0x…: re-score just that wallet now (manual fix-up). dry=1: compute only, write nothing.
 * Idempotent and safe to run twice (run lock + per-unlock SET NX). Auth: Bearer CRON_SECRET (constant-time); in
 * production an unset CRON_SECRET ⇒ 503 (never an open endpoint).
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { indexTrades } from "@/lib/server/trades";
import { runAchievements, scoreWallet } from "@/lib/server/achievements";

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
  if (process.env.ACHIEVEMENTS_DISABLED === "1") return NextResponse.json({ ok: true, skipped: "disabled" }, { headers: NO_STORE });
  const u = new URL(req.url);
  const dryRun = u.searchParams.get("dry") === "1";
  const wallet = u.searchParams.get("wallet");
  if (wallet !== null && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  try {
    if (wallet) {
      const r = await scoreWallet(wallet, { dryRun });
      return NextResponse.json({ ok: true, dryRun, ...r }, { headers: NO_STORE });
    }
    const idx = dryRun ? null : await indexTrades(10_000).catch((e) => ({ error: (e as Error).message }));
    const r = await runAchievements({ budgetMs: 40_000, dryRun });
    return NextResponse.json({ ...r, dryRun, trades: idx }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500, headers: NO_STORE });
  }
}

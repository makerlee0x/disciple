/**
 * GET (Vercel cron / external pinger): chain catch-up for coins with a subscriber in the last 10 min, then the trade
 * indexer (trades:*). Auth: Bearer CRON_SECRET (constant-time compare). In production (VERCEL_ENV or NODE_ENV =
 * production) CRON_SECRET is REQUIRED: unset ⇒ 503, never an open endpoint. Local dev without it stays open.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { chatStore } from "@/lib/server/chat/store";
import { catchUp } from "@/lib/server/chat/chain";
import { indexTrades } from "@/lib/server/trades";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
/** Constant-time: compare SHA-256 digests (equal length regardless of input). */
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const coins = await chatStore().activeSince(Date.now() - 10 * 60_000);
  const res: Record<string, number> = {};
  for (const c of coins.slice(0, 25)) res[c] = await catchUp(c);
  const trades = await indexTrades(25_000).catch((e) => ({ error: (e as Error).message }));
  return NextResponse.json({ ok: true, store: chatStore().kind, coins: res, trades });
}

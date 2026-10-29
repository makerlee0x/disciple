/** GET /api/profile/stats?wallet=0x… → { wallet, summary: { realizedPnlUsd, winRate, closedTrades, bombsDropped, … }, trades } from the trade index. Public: PnL is public on profiles (lee, Oct 26 2026). */
import { NextResponse } from "next/server";
import { serverProfileStats } from "@/lib/server/profileStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!isAddr(wallet)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  try {
    const s = await serverProfileStats(wallet);
    return NextResponse.json(s, { headers: { "cache-control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    console.warn("[disciple] profile stats route failed", (e as Error).message);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

/** GET /api/trades?coin=0x…[&wallet=0x…][&limit=n] → { fills } oldest→newest. Runs a short indexer catch-up first. */
import { NextResponse } from "next/server";
import { indexTrades, tradesOf, coinsOf } from "@/lib/server/trades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const u = new URL(req.url);
  const coin = u.searchParams.get("coin"), wallet = u.searchParams.get("wallet");
  const limit = Math.min(5000, Math.max(1, Number(u.searchParams.get("limit")) || 1000));
  if (coin !== null && !isAddr(coin)) return NextResponse.json({ error: "bad coin" }, { status: 400 });
  if (wallet !== null && !isAddr(wallet)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  if (!coin && !wallet) return NextResponse.json({ error: "coin or wallet required" }, { status: 400 });
  await indexTrades(5_000).catch((e) => console.warn("[trades] index failed", (e as Error).message));
  if (!coin) return NextResponse.json({ wallet: wallet!.toLowerCase(), coins: await coinsOf(wallet!) });
  return NextResponse.json({ coin: coin.toLowerCase(), wallet: wallet?.toLowerCase() ?? null, fills: await tradesOf(coin, wallet, limit) });
}

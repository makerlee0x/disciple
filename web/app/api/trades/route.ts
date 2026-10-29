/** GET /api/trades?coin=0x…[&wallet=0x…][&limit=n≤5000][&order=asc|desc] → { fills } oldest→newest (desc = newest n). Runs a short indexer catch-up first. */
import { NextResponse } from "next/server";
import { indexTrades, tradesOf, coinsOf, TRADES_MAX_LIMIT } from "@/lib/server/trades";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `trades:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.tradesPerIp.limit, PUBLIC_GET_LIMITS.tradesPerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const u = new URL(req.url);
  const coin = u.searchParams.get("coin"), wallet = u.searchParams.get("wallet");
  const limit = Math.min(TRADES_MAX_LIMIT, Math.max(1, Number(u.searchParams.get("limit")) || 1000));
  const order = u.searchParams.get("order") === "desc" ? "desc" : "asc";
  if (coin !== null && !isAddr(coin)) return NextResponse.json({ error: "bad coin" }, { status: 400 });
  if (wallet !== null && !isAddr(wallet)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  if (!coin && !wallet) return NextResponse.json({ error: "coin or wallet required" }, { status: 400 });
  await indexTrades(5_000).catch((e) => console.warn("[trades] index failed", (e as Error).message));
  if (!coin) return NextResponse.json({ wallet: wallet!.toLowerCase(), coins: await coinsOf(wallet!) });
  return NextResponse.json({ coin: coin.toLowerCase(), wallet: wallet?.toLowerCase() ?? null, fills: await tradesOf(coin, wallet, limit, order) });
}

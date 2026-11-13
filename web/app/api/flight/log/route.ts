export const runtime = "nodejs";
/**
 * GET /api/flight/log?wallet=0x…&coin=0x…&since=<ms> → FlightLog (lib/flightLog.ts): the leave card's numbers, from the
 * indexed fills only (the query picks the window, never a number). Public data, rate limited per IP.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { flightLogFor } from "@/lib/server/flightLog";

export const dynamic = "force-dynamic";
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const wallet = (q.get("wallet") || "").toLowerCase(), coin = (q.get("coin") || "").toLowerCase();
  const since = Number(q.get("since"));
  if (!isAddr(wallet) || !isAddr(coin) || !Number.isFinite(since)) return NextResponse.json({ error: "wallet, coin and since required" }, { status: 400 });
  const rl = await hitLimit(kv(), `flightlog:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  try {
    return NextResponse.json(await flightLogFor(wallet, coin, since), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

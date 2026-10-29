/** GET /api/home[?coin=0x…] → HomeData (trending hero + feed stats; lib/server/home). `coin` = the hero the visitor
 * landed on: its latest fills come back as `chips` even if another coin has since taken #1 (the hero never rotates). */
import { NextResponse } from "next/server";
import { getHomeData } from "@/lib/server/home";
import { tradesOf } from "@/lib/server/trades";
import { chipOf } from "@/lib/home/trending";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `home:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.homePerIp.limit, PUBLIC_GET_LIMITS.homePerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const coin = new URL(req.url).searchParams.get("coin");
  if (coin !== null && !isAddr(coin)) return NextResponse.json({ error: "bad coin" }, { status: 400 });
  const data = await getHomeData();
  let chips = data.chips;
  if (coin && coin.toLowerCase() !== data.hero) {
    const fills = await tradesOf(coin, null, 6, "desc").catch(() => []);
    chips = fills.reverse().map(chipOf);
  }
  return NextResponse.json({ ...data, chips }, { headers: { "cache-control": "public, max-age=0, s-maxage=15, stale-while-revalidate=30" } });
}

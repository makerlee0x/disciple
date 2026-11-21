/**
 * GET /api/coin/mcap?coin=0x… → { mcapUsd, graduated }: the one number the flight engine needs for its first frame.
 * The coin page fetches it from an inline script in the first HTML (app/coin/[address]/layout.tsx), in parallel with the
 * page JS, so the rocket can fly before the browser's own chain reads (speed pass, maker 2026-11-20). Two chain reads,
 * a 2 s in-process memo and a 2 s shared cache; the per-IP limit only runs when the memo misses.
 */
import { NextResponse } from "next/server";
import type { Address, PublicClient } from "viem";
import { isAddr } from "@/lib/holders";
import { readCoinMcap } from "@/lib/mcap";
import { serverPc } from "@/lib/server/chat/identity";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { kv } from "@/lib/server/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;
const PER_IP = { limit: 60, windowSec: 60 };
const MEMO_MS = 2000;
const memo = new Map<string, { at: number; p: Promise<{ mcapUsd: number; graduated: boolean }> }>();
const CACHE = { "Cache-Control": "public, s-maxage=2, stale-while-revalidate=20" };

export async function GET(req: Request) {
  const coin = new URL(req.url).searchParams.get("coin")?.toLowerCase() ?? null;
  if (!isAddr(coin)) return NextResponse.json({ error: "bad coin" }, { status: 400 });
  let hit = memo.get(coin);
  if (!hit || Date.now() - hit.at > MEMO_MS) {
    // the limit check (a KV round trip) runs alongside the chain reads instead of before them (speed pass 2026-11-21):
    // this number gates the rocket's first frame. A limited caller still gets its 429; the read only warms the memo.
    const limit = hitLimit(kv(), `coinmcap:${clientIp(req.headers)}`, PER_IP.limit, PER_IP.windowSec);
    const p = readCoinMcap(serverPc() as unknown as PublicClient, coin as Address).then((m) => ({ mcapUsd: m.mcapUsd, graduated: m.graduated }));
    hit = { at: Date.now(), p };
    memo.set(coin, hit);
    p.catch(() => memo.delete(coin));
    if (memo.size > 500) memo.delete(memo.keys().next().value as string);
    const rl = await limit;
    if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }
  try {
    return NextResponse.json(await hit.p, { headers: CACHE });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "unknown coin") return NextResponse.json({ error: "unknown coin" }, { status: 404 });
    console.warn("[coinmcap]", msg);
    return NextResponse.json({ error: "mcap unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

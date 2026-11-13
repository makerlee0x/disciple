export const runtime = "nodejs";
/**
 * Rocket looks (lib/server/looks.ts).
 * GET ?wallets=0x…,0x… (≤100) [&coin=0x…] → { looks: { wallet: { hull, flare } }, host?: { wallet, hull, flare } }. host is the
 *   coin's launcher with their looks (stock when none stored). Public, cached 30 s.
 * POST { address, nonce, signature, owner?, hull, flare } → { ok, looks } | { ok: false, reason }. Signed like /api/shop/buy
 *   (nonce from GET /api/xp?nonce=1), checked against the pilot's unlocks.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { getHomeData } from "@/lib/server/home";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { looksOf, saveLooks, STOCK_LOOKS } from "@/lib/server/looks";
import { verifySigned, type SignedBody } from "@/lib/server/xpAuth";
import { looksMessage } from "@/lib/xp";

export const dynamic = "force-dynamic";
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
const id = (v: unknown) => (typeof v === "string" && /^[a-z0-9-]{1,24}$/.test(v) ? v : "");

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const wallets = (q.get("wallets") || "").toLowerCase().split(",").map((w) => w.trim()).filter(isAddr).slice(0, 100);
  const coin = (q.get("coin") || "").toLowerCase();
  try {
    let creator = "";
    if (isAddr(coin)) creator = (await getHomeData()).coins.find((c) => c.token.toLowerCase() === coin)?.creatorAddr ?? "";
    const looks = await looksOf(creator ? [...wallets, creator] : wallets);
    const host = creator ? { wallet: creator, ...(looks[creator] ?? STOCK_LOOKS) } : undefined;
    return NextResponse.json({ looks, ...(host ? { host } : {}) }, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `looks:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return NextResponse.json({ ok: false, reason: "Too many requests, try again shortly." }, { status: 429 });
  let body: SignedBody & { hull?: unknown; flare?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const hull = id(body?.hull), flare = id(body?.flare);
  if (!hull || !flare) return NextResponse.json({ ok: false, reason: "Pick a hull and a flare." }, { status: 400 });
  const v = await verifySigned(body, (a, n) => looksMessage(a, hull, flare, n));
  if (!v.ok) return NextResponse.json({ ok: false, reason: v.reason }, { status: v.status });
  const r = await saveLooks(v.wallet, hull, flare);
  return NextResponse.json(r, { status: r.ok ? 200 : 409, headers: { "cache-control": "no-store" } });
}

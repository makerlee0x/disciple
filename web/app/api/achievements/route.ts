/**
 * GET /api/achievements?wallet=0x… → V1 achievements of one trading account (Trade.trader: the smart account for router
 * trades). Public, KV-only (no RPC, no scoring — the cron scores), cached 30 s at the edge.
 * Body: { wallet, chainId, rulesVersion, evaluatedAt: ms|null, items: [{ id, name, rarity, unlockedAt?, tx?, block?,
 *   logIndex?, coin?, progress, target }] } — one item per V1 rule (lib/achievements.ts V1_RULES), unlocked or not.
 * evaluatedAt null = the engine hasn't scored this wallet yet (no trades, or the first backfill is still running).
 */
import { NextResponse } from "next/server";
import { achievementsOf, claimAnonHost } from "@/lib/server/achievements";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ error: "wallet=0x… required" }, { status: 400 });
  try {
    return NextResponse.json(await achievementsOf(wallet), { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

/**
 * POST { coin, sig } with the Privy session (Bearer; optional x-wallet picks one of the account's wallets): credit a hidden
 * launch to this account's trophies. sig = the coin's stealth owner over lib/coinLook anonHostMessage. Kept private.
 */
export async function POST(req: Request) {
  const no = (status: number, reason: string) => NextResponse.json({ ok: false, reason }, { status, headers: { "cache-control": "no-store" } });
  const rl = await hitLimit(kv(), `ach:anonhost:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return no(429, "Too many requests, try again shortly.");
  let b: { coin?: unknown; sig?: unknown };
  try { b = await req.json(); } catch { return no(400, "Bad JSON"); }
  if (typeof b.coin !== "string" || typeof b.sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.sig)) return no(400, "bad request");
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return no(auth.status, "Sign in first.");
  const wallets = auth.user.wallets.map((x) => x.toLowerCase());
  const want = (req.headers.get("x-wallet") || "").toLowerCase();
  const wallet = wallets.includes(want) ? want : wallets[0];
  if (!wallet) return no(403, "Your account needs a wallet.");
  try {
    const r = await claimAnonHost(b.coin, wallet, b.sig as `0x${string}`);
    return r.ok ? NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } }) : no(r.status, r.reason);
  } catch (e) { console.error("[achievements] anonhost", e); return no(503, "Try again in a moment."); }
}

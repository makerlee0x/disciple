/**
 * Lobby rocket cards: "N of your crew aboard". GET ?wallet=0x…&coins=0x…,0x… (up to 30) with a Privy bearer token for
 * that wallet → { aboard: { [coin]: n } }. Owner only; counts, never names or sizes.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { crewAboardFor } from "@/lib/server/crew";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
const out = (status: number, b: unknown) => NextResponse.json(b, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `crewaboard:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return out(429, { error: "Too many requests" });
  const q = new URL(req.url).searchParams;
  const wallet = (q.get("wallet") || "").toLowerCase();
  const coins = (q.get("coins") || "").toLowerCase().split(",").filter(isAddr).slice(0, 30);
  if (!isAddr(wallet)) return out(400, { error: "wallet=0x… required" });
  const tok = bearer(req.headers);
  const a = tok ? await authenticate(tok, privyEnv()) : null;
  if (!a?.ok || !a.user.wallets.some((x) => x.toLowerCase() === wallet)) return out(401, { error: "Sign in" });
  try { return out(200, { aboard: await crewAboardFor(wallet, coins) }); }
  catch { return out(200, { aboard: {} }); }
}

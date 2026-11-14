/**
 * Crew flights (main mode hook loop, maker 2026-11-13). GET ?wallet=0x… with a Privy bearer token for that wallet →
 * CrewPage (lib/server/crew). Owner only. Opening it is the day's check-in (lib/streaks) and pays the weekly crew
 * mission when it's met.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { crewPageFor } from "@/lib/server/crew";
import { checkIn } from "@/lib/server/streaks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const out = (status: number, b: unknown) => NextResponse.json(b, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `crew:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { error: "Too many requests" });
  const wallet = (new URL(req.url).searchParams.get("wallet") || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return out(400, { error: "wallet=0x… required" });
  const tok = bearer(req.headers);
  const a = tok ? await authenticate(tok, privyEnv()) : null;
  if (!a?.ok || !a.user.wallets.some((x) => x.toLowerCase() === wallet)) return out(401, { error: "Sign in to see your crew" });
  await checkIn(wallet).catch(() => {});
  try { return out(200, await crewPageFor(wallet)); }
  catch { return out(503, { error: "Crew is unavailable right now" }); }
}

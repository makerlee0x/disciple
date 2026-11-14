/**
 * Steady-hand streaks (main mode hook loop, maker 2026-11-13).
 * GET ?wallet=0x… with a Privy bearer token for that wallet → { aboard, checkin, paid } (lib/server/streaks), and pays
 * any streak XP now due. Owner only: a streak is yours, not a leaderboard.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { streaksFor } from "@/lib/server/streaks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const out = (status: number, b: unknown) => NextResponse.json(b, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `streaks:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { error: "Too many requests" });
  const wallet = (new URL(req.url).searchParams.get("wallet") || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return out(400, { error: "wallet=0x… required" });
  const tok = bearer(req.headers);
  const a = tok ? await authenticate(tok, privyEnv()) : null;
  if (!a?.ok || !a.user.wallets.some((x) => x.toLowerCase() === wallet)) return out(401, { error: "Sign in to see your streaks" });
  try { return out(200, await streaksFor(wallet)); }
  catch { return out(503, { error: "Streaks are unavailable right now" }); }
}

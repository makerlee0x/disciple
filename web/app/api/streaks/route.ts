/**
 * Streaks, daily drop and season track (lib/server/streaks). Owner only: a streak is yours, not a leaderboard.
 * GET  ?wallet=0x… with a Privy bearer token for that wallet → { aboard, checkin, flight, drop, track, paid }, and pays any
 *      streak XP now due (and season-track crates reached).
 * POST { wallet, op: "claim" }              → today's daily drop: checks in and pays it once → { ok, day, xp, crate, paid }
 * POST { wallet, op: "play", mode }          → today's flight streak day (a Turbo match finished on this device) → { ok }
 *      A play ping is the pilot's word, like the check-in: it pays 20 XP a day at most, so taking it costs nothing.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { claimDrop, recordPlay, streaksFor } from "@/lib/server/streaks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const out = (status: number, b: unknown) => NextResponse.json(b, { status, headers: { "cache-control": "private, no-store" } });
const isAddr = (w: unknown): w is string => typeof w === "string" && /^0x[0-9a-f]{40}$/.test(w);

async function owns(req: Request, wallet: string) {
  const tok = bearer(req.headers);
  const a = tok ? await authenticate(tok, privyEnv()) : null;
  return !!a?.ok && a.user.wallets.some((x) => x.toLowerCase() === wallet);
}

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `streaks:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { error: "Too many requests" });
  const wallet = (new URL(req.url).searchParams.get("wallet") || "").toLowerCase();
  if (!isAddr(wallet)) return out(400, { error: "wallet=0x… required" });
  if (!(await owns(req, wallet))) return out(401, { error: "Sign in to see your streaks" });
  try { return out(200, await streaksFor(wallet)); }
  catch { return out(503, { error: "Streaks are unavailable right now" }); }
}

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `streaks:post:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests" });
  const b = (await req.json().catch(() => null)) as { wallet?: unknown; op?: unknown; mode?: unknown } | null;
  const wallet = typeof b?.wallet === "string" ? b.wallet.toLowerCase() : "";
  if (!isAddr(wallet)) return out(400, { ok: false, reason: "wallet required" });
  if (!(await owns(req, wallet))) return out(401, { ok: false, reason: "Sign in first" });
  try {
    if (b?.op === "claim") return out(200, { ok: true, ...(await claimDrop(wallet)) });
    if (b?.op === "play") return (await recordPlay(wallet, b.mode)) ? out(200, { ok: true }) : out(400, { ok: false, reason: "bad mode" });
    return out(400, { ok: false, reason: "bad op" });
  } catch { return out(503, { ok: false, reason: "Streaks are unavailable right now" }); }
}

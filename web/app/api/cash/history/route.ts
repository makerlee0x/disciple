export const runtime = "nodejs";
/**
 * GET (Bearer, x-wallet?) → { ok, rows, done }   the signed-in pilot's money rows for the Flight log (lib/server/cashHistory):
 * market buys and sales, deposits, withdrawals, Turbo cash in and out, creator fees, rewards. Own wallet only.
 * `done: false` = the chain scan is still catching up (a first visit with a long history); the next read continues it.
 */
import { NextResponse } from "next/server";
import { cashHistory } from "@/lib/server/cashHistory";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 20;
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `cash:hist:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return out(auth.status, { ok: false, reason: "Sign in first." });
  const wallets = auth.user.wallets.map((x) => x.toLowerCase());
  const want = req.headers.get("x-wallet");
  const wallet = isAddr(want) && wallets.includes(want.toLowerCase()) ? want.toLowerCase() : wallets[0];
  if (!wallet) return out(403, { ok: false, reason: "Your account needs a wallet." });
  try {
    const r = await cashHistory(wallet);
    return out(200, { ok: true, ...r });
  } catch (e) {
    console.error("[cash:history]", e);
    return out(503, { ok: false, reason: "History isn't loading. Try again." });
  }
}

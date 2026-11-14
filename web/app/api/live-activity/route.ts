export const runtime = "nodejs";
/**
 * iPhone app Live Activity (lib/server/liveActivity). POST { wallet, coin, ticker, token, env } with the Privy session
 * (Authorization: Bearer) registers the activity's push token so the server can keep the lock screen current while the app
 * is closed. DELETE { token } stops it (the token itself is the secret: only that phone has it).
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { dropLive, registerLive } from "@/lib/server/liveActivity";
import { validApnsToken } from "@/lib/server/apns";

export const dynamic = "force-dynamic";
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `la:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  let b: { wallet?: unknown; coin?: unknown; ticker?: unknown; token?: unknown; env?: unknown };
  try { b = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  if (!isAddr(b?.wallet) || !isAddr(b?.coin) || !validApnsToken(b?.token)) return out(400, { ok: false, reason: "wallet, coin and token required" });
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return out(auth.status, { ok: false, reason: auth.reason });
  if (!auth.user.wallets.map((x) => x.toLowerCase()).includes(b.wallet.toLowerCase())) return out(403, { ok: false, reason: "That wallet isn't on your account." });
  const ok = await registerLive(b.wallet, { token: b.token, env: b.env, coin: b.coin, ticker: b.ticker });
  return out(ok ? 200 : 400, { ok });
}

export async function DELETE(req: Request) {
  const rl = await hitLimit(kv(), `la:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return out(429, { ok: false });
  let b: { token?: unknown };
  try { b = await req.json(); } catch { return out(400, { ok: false }); }
  if (!validApnsToken(b?.token)) return out(400, { ok: false });
  await dropLive(b.token);
  return out(200, { ok: true });
}

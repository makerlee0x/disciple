export const runtime = "nodejs";
/**
 * The iPhone app's flight Live Activity (lib/server/liveActivity). POST registers one, DELETE drops it.
 * POST { token, env: "production" | "sandbox", coin, ticker, investedUsd, share, wallet? } · DELETE { token }
 * The token is the activity's own push token (it can only update that one lock-screen card), so no sign-in is needed;
 * requests are rate limited per IP.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { validApnsToken } from "@/lib/server/apns";
import { dropLive, registerLive } from "@/lib/server/liveActivity";

export const dynamic = "force-dynamic";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const num = (v: unknown, max: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };

async function body(req: Request): Promise<Record<string, unknown> | null> { try { return (await req.json()) as Record<string, unknown>; } catch { return null; } }

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `la:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests" });
  const b = await body(req);
  const token = typeof b?.token === "string" ? b.token.toLowerCase() : "";
  const investedUsd = num(b?.investedUsd, 1e9), share = num(b?.share, 1);
  if (!b || !validApnsToken(token) || !isAddr(b.coin) || investedUsd === null || share === null) return out(400, { ok: false, reason: "token, coin, investedUsd and share required" });
  const env = b.env === "sandbox" ? "sandbox" : "production";
  const ticker = typeof b.ticker === "string" ? b.ticker.replace(/[^A-Za-z0-9$]/g, "").slice(0, 12) : "";
  await registerLive({ token, env, wallet: isAddr(b.wallet) ? b.wallet.toLowerCase() : null, coin: b.coin.toLowerCase(), ticker, investedUsd, share, at: Date.now() });
  return out(200, { ok: true });
}

export async function DELETE(req: Request) {
  const b = await body(req);
  const token = typeof b?.token === "string" ? b.token.toLowerCase() : "";
  if (!validApnsToken(token)) return out(400, { ok: false });
  await dropLive(token);
  return out(200, { ok: true });
}

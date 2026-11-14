export const runtime = "nodejs";
/**
 * STYLE FILLs (lib/xp STYLE). The flight reports a spin / flip next to your own boost fill here:
 * POST { wallet, coin, at, combo } with the Privy session (Authorization: Bearer <access token>), no wallet signature.
 * → { ok, xp, paidToday, queuedToday, capped } | { ok: false, reason }
 * Nothing is paid here: the claim is queued and the achievements cron pays it (lib/server/xp scoreXp) only when the fills show
 * the wallet's own buy of $5+ on that coin within 20 s of the report. At most 6 a day.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { queueStyle } from "@/lib/server/xp";
import { STYLE } from "@/lib/xp";

export const dynamic = "force-dynamic";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `xp:style:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  let body: { wallet?: unknown; coin?: unknown; at?: unknown; combo?: unknown };
  try { body = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  const at = Number(body?.at), now = Date.now();
  const combo = Math.max(1, Math.min(STYLE.maxCombo, Math.floor(Number(body?.combo)) || 1));
  if (!isAddr(body?.wallet) || !isAddr(body?.coin)) return out(400, { ok: false, reason: "wallet and coin required" });
  if (!Number.isFinite(at) || at > now + 5_000 || at < now - 120_000) return out(400, { ok: false, reason: "Stale style fill." });
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return out(auth.status, { ok: false, reason: auth.reason });
  const wallet = body.wallet.toLowerCase();
  if (!auth.user.wallets.map((x) => x.toLowerCase()).includes(wallet)) return out(403, { ok: false, reason: "That wallet isn't on your account." });
  const wl = await hitLimit(kv(), `xp:style:w:${wallet}`, 10, 60);
  if (!wl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  const r = await queueStyle(wallet, { coin: body.coin.toLowerCase(), at: Math.min(at, now), combo }, now);
  return out(r.ok ? 200 : 409, r);
}

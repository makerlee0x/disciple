export const runtime = "nodejs";
/**
 * Drafting slingshots (lib/xp DRAFT). The flight reports a full Draft meter here:
 * POST { wallet, coin, wingmen: ["0x…"], at } with the Privy session (Authorization: Bearer <access token>), no wallet signature.
 * → { ok, paidToday, queuedToday, capped } | { ok: false, reason }
 * Nothing is paid here: the claim is queued and the achievements cron pays it (lib/server/xp scoreXp) only when the fills
 * show the wallet aboard with $5+ and a drafted pilot boosting that coin in the minute before. At most 5 a day.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { queueDraft } from "@/lib/server/xp";
import { DRAFT } from "@/lib/xp";

export const dynamic = "force-dynamic";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `xp:draft:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  let body: { wallet?: unknown; coin?: unknown; wingmen?: unknown; at?: unknown };
  try { body = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  const wingmen = Array.isArray(body?.wingmen) ? Array.from(new Set(body.wingmen.filter(isAddr).map((x) => x.toLowerCase()))).slice(0, DRAFT.maxWingmen) : [];
  const at = Number(body?.at), now = Date.now();
  if (!isAddr(body?.wallet) || !isAddr(body?.coin) || !wingmen.length) return out(400, { ok: false, reason: "wallet, coin and wingmen required" });
  if (!Number.isFinite(at) || at > now + 5_000 || at < now - 120_000) return out(400, { ok: false, reason: "Stale slingshot." });
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return out(auth.status, { ok: false, reason: auth.reason });
  const wallet = body.wallet.toLowerCase();
  if (!auth.user.wallets.map((x) => x.toLowerCase()).includes(wallet)) return out(403, { ok: false, reason: "That wallet isn't on your account." });
  const wl = await hitLimit(kv(), `xp:draft:w:${wallet}`, 10, 60);
  if (!wl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  const r = await queueDraft(wallet, { coin: body.coin.toLowerCase(), wingmen, at: Math.min(at, now) }, now);
  return out(r.ok ? 200 : 409, r);
}

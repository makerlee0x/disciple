/**
 * Push alerts settings (main mode hook loop, maker 2026-11-13). All need a Privy bearer token for `wallet`.
 *   GET    ?wallet=        → { configured, web, app, publicKey, prefs, devices }
 *   POST   { wallet, endpoint }          subscribe this browser
 *   POST   { wallet, apns, env }         subscribe the iPhone app (APNs token, env "production" | "sandbox")
 *   PUT    { wallet, prefs }             one switch per kind (lib/push PUSH_KINDS)
 *   DELETE { wallet, endpoint | apns }   unsubscribe this device
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { appPushConfigured, prefsOf, pushConfigured, pushPublicKey, setPrefs, subscribe, subsOf, unsubscribe, webPushConfigured } from "@/lib/server/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const out = (status: number, b: unknown) => NextResponse.json(b, { status, headers: { "cache-control": "private, no-store" } });
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

async function owner(req: Request, wallet: unknown): Promise<string | NextResponse> {
  const rl = await hitLimit(kv(), `push:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { error: "Too many requests" });
  if (!isAddr(wallet)) return out(400, { error: "wallet=0x… required" });
  const tok = bearer(req.headers);
  const a = tok ? await authenticate(tok, privyEnv()) : null;
  if (!a?.ok || !a.user.wallets.some((x) => x.toLowerCase() === wallet.toLowerCase())) return out(401, { error: "Sign in" });
  return wallet.toLowerCase();
}
const body = async (req: Request) => (await req.json().catch(() => ({}))) as { wallet?: unknown; endpoint?: unknown; apns?: unknown; env?: unknown; prefs?: unknown };
const deviceOf = (b: { endpoint?: unknown; apns?: unknown; env?: unknown }) => (b.apns != null ? { apns: b.apns, env: b.env } : b.endpoint);

export async function GET(req: Request) {
  const w = await owner(req, new URL(req.url).searchParams.get("wallet"));
  if (typeof w !== "string") return w;
  const [prefs, subs] = await Promise.all([prefsOf(w), subsOf(w)]);
  return out(200, { configured: pushConfigured(), web: webPushConfigured(), app: appPushConfigured(), publicKey: pushPublicKey(), prefs, devices: subs.length });
}
export async function POST(req: Request) {
  const b = await body(req), w = await owner(req, b.wallet);
  if (typeof w !== "string") return w;
  const app = b.apns != null;
  if (app ? !appPushConfigured() : !webPushConfigured()) return out(503, { error: "Push alerts aren't set up yet" });
  return (await subscribe(w, deviceOf(b))) ? out(200, { ok: true }) : out(400, { error: app ? "That device token isn't valid" : "That browser's push service isn't supported" });
}
export async function PUT(req: Request) {
  const b = await body(req), w = await owner(req, b.wallet);
  if (typeof w !== "string") return w;
  return out(200, { prefs: await setPrefs(w, b.prefs) });
}
export async function DELETE(req: Request) {
  const b = await body(req), w = await owner(req, b.wallet);
  if (typeof w !== "string") return w;
  if (typeof b.endpoint === "string" || b.apns != null) await unsubscribe(w, deviceOf(b));
  return out(200, { ok: true });
}

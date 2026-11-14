import "server-only";
/** Shared bits for /api/duel/*: signed-in pilot (Privy), JSON replies, errors. */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { usernameOf } from "@/lib/server/usernames";
import { hasTurboPass, TURBO_PASS_COOKIE } from "@/lib/server/turboPass";
import { DuelError, type Pilot } from "./store";

export const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** Duels sit behind the same pre-launch Turbo password as /turbo. */
export function requirePass(req: Request) {
  const c = (req.headers.get("cookie") || "").split(/;\s*/).find((x) => x.startsWith(TURBO_PASS_COOKIE + "="));
  if (!hasTurboPass(c ? decodeURIComponent(c.slice(TURBO_PASS_COOKIE.length + 1)) : undefined)) throw new DuelError(403, "Turbo isn't open yet.");
}
/** The signed-in pilot. Optional `x-wallet` picks which of their wallets (must be on their account). */
export async function pilotOf(req: Request): Promise<Pilot> {
  const rl = await hitLimit(kv(), `duel:ip:${clientIp(req.headers)}`, 240, 60);
  if (!rl.ok) throw new DuelError(429, "Slow down a little.");
  requirePass(req);
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) throw new DuelError(auth.status, "Sign in to duel.");
  const wallets = auth.user.wallets.map((w) => w.toLowerCase());
  const want = req.headers.get("x-wallet");
  const pid = isAddr(want) && wallets.includes(want.toLowerCase()) ? want.toLowerCase() : wallets[0];
  if (!pid) throw new DuelError(403, "Your account needs a wallet to duel.");
  const name = (await usernameOf(pid).catch(() => null)) || `pilot-${pid.slice(2, 6)}`;
  return { pid, name: name.startsWith("@") ? name : "@" + name };
}
export async function body<T>(req: Request, max = 4000): Promise<T> {
  const raw = await req.text(); if (raw.length > max) throw new DuelError(413, "Too big.");
  try { return (raw ? JSON.parse(raw) : {}) as T; } catch { throw new DuelError(400, "Bad JSON"); }
}
export function fail(e: unknown) {
  if (e instanceof DuelError) return out(e.status, { ok: false, reason: e.message });
  console.error("[duel]", e);
  return out(500, { ok: false, reason: "Something broke. Try again." });
}

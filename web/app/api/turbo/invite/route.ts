export const runtime = "nodejs";
/**
 * GET /api/turbo/invite?c=CODE → a friend's live duel link opens without the Turbo password (maker, 2026-11-15: "Open in
 * app + invite links"). If the code is open, sets the short invite cookie (lib/server/turboPass) and sends the pilot to the
 * duel; otherwise back to the duel page with ?closed=1 so the gate can say the link has closed. Rate limited per IP.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { TURBO_INVITE_COOKIE, TURBO_INVITE_MAX_AGE, turboInviteToken } from "@/lib/server/turboPass";
import { withBase } from "@/lib/base-path";
import { parseCode } from "@/lib/duel/rules";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = parseCode(u.searchParams.get("c"));
  // ?to=duel: the link came from the duel-only demo page (/duel), so send them back there
  const page = u.searchParams.get("to") === "duel" ? "/duel" : "/turbo/duel";
  const to = (q: string) => NextResponse.redirect(new URL(withBase(`${page}?${q}`), u.origin), { status: 303, headers: { "cache-control": "no-store" } });
  if (!code) return to("closed=1");
  try {
    const ipTag = createHash("sha256").update(clientIp(req.headers)).digest("hex").slice(0, 16);
    if (!(await hitLimit(kv(), `tinvite:${ipTag}`, 20, 60)).ok) return to(`c=${code}&closed=1`);
    const room = await kv().get(`duel:code:${code}`);
    if (!room || room === "pending") return to(`c=${code}&closed=1`);
  } catch { return to(`c=${code}&closed=1`); }
  const res = to(`c=${code}`);
  res.cookies.set(TURBO_INVITE_COOKIE, turboInviteToken(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TURBO_INVITE_MAX_AGE });
  return res;
}

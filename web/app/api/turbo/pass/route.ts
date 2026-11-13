export const runtime = "nodejs";
/** POST /api/turbo/pass { password } → 204 and the pass cookie, or 401. Rate limited per IP (10 a minute). */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { TURBO_PASS_COOKIE, TURBO_PASS_MAX_AGE, checkTurboPassword, turboPassToken } from "@/lib/server/turboPass";

export const dynamic = "force-dynamic";
const done = (status: number) => new NextResponse(null, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  let pw: unknown;
  try { pw = ((await req.json()) as { password?: unknown })?.password; } catch { return done(400); }
  if (typeof pw !== "string" || pw.length > 200) return done(400);
  try {
    const ipTag = createHash("sha256").update(clientIp(req.headers)).digest("hex").slice(0, 16);
    const lim = await hitLimit(kv(), `tpass:${ipTag}`, 10, 60);
    if (!lim.ok) return done(429);
  } catch { /* KV down: still check the password */ }
  if (!checkTurboPassword(pw)) return done(401);
  const res = done(204);
  res.cookies.set(TURBO_PASS_COOKIE, turboPassToken(pw.trim().toLowerCase()), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TURBO_PASS_MAX_AGE });
  return res;
}

/** Ref link landing: /r/<username> or /r/<0xwallet>. Sets first-touch cookie (30d) and redirects home. */
import { NextResponse, type NextRequest } from "next/server";
import { REF_COOKIE, REF_TTL_MS, parseRef } from "@/lib/referral";
import { USERNAME_RE } from "@/lib/profile";
import { usernameOf, walletOf } from "@/lib/server/usernames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { username: string } }) {
  const raw = decodeURIComponent(params.username || "").trim().toLowerCase().replace(/^@/, "");
  const res = NextResponse.redirect(new URL("/", req.url), 307);
  const existing = parseRef(req.cookies.get(REF_COOKIE)?.value);
  if (existing) return res; // first touch wins
  let u: string | null = null, a: string | null = null;
  try {
    if (/^0x[0-9a-f]{40}$/.test(raw)) { a = raw; u = await usernameOf(raw); }
    else if (USERNAME_RE.test(raw)) { u = raw; a = await walletOf(raw); }
  } catch { /* store down: still record the username */ }
  if (!u && !a) return res;
  res.cookies.set(REF_COOKIE, JSON.stringify({ u, a, t: Date.now() }), {
    maxAge: Math.floor(REF_TTL_MS / 1000), path: "/", sameSite: "lax", secure: new URL(req.url).protocol === "https:", httpOnly: false,
  });
  return res;
}

/** Ref link landing: /r/<username> or /r/<0xwallet>. Sets first-touch cookie (30d) and redirects home. */
import { NextResponse, type NextRequest } from "next/server";
import { REF_COOKIE, REF_TTL_MS, parseRef } from "@/lib/referral";
import { USERNAME_STORED_RE } from "@/lib/profile";
import { usernameOf, walletOf } from "@/lib/server/usernames";
import { SITE_ORIGIN, isPreviewBot, previewPage } from "@/lib/server/og/botPage";
import { inviterName } from "@/lib/server/og/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const raw = decodeURIComponent(username || "").trim().toLowerCase().replace(/^@/, "");
  if (isPreviewBot(req.headers.get("user-agent"))) {
    // link preview crawlers: the invite card (naming the sender when the name exists), no cookie
    const o = SITE_ORIGIN, from = await inviterName(raw).catch(() => null);
    return previewPage({
      title: from ? `@${from} invited you to DISCIPLE` : "You're invited to DISCIPLE", description: "Take your seat and boost your first rocket.",
      image: `${o}/api/og/invite${from ? `?from=${encodeURIComponent(from)}` : ""}`, url: `${o}/r/${encodeURIComponent(raw)}`, to: `${o}/`,
    });
  }
  const res = NextResponse.redirect(new URL("/", req.url), 307);
  const existing = parseRef(req.cookies.get(REF_COOKIE)?.value);
  if (existing) return res; // first touch wins
  let u: string | null = null, a: string | null = null;
  try {
    if (/^0x[0-9a-f]{40}$/.test(raw)) { a = raw; u = await usernameOf(raw); }
    else if (USERNAME_STORED_RE.test(raw)) { a = await walletOf(raw); if (a) u = raw; }
  } catch { /* store down: do not write a no-wallet cookie */ }
  if (!a) return res;
  res.cookies.set(REF_COOKIE, JSON.stringify({ u, a, t: Date.now() }), {
    maxAge: Math.floor(REF_TTL_MS / 1000), path: "/", sameSite: "lax", secure: new URL(req.url).protocol === "https:", httpOnly: false,
  });
  return res;
}

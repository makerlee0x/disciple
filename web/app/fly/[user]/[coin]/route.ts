/**
 * Fly with me: /fly/<username>/<ticker>. Sets the first-touch referral cookie for the inviter (same as /r/<username>)
 * and opens the invite landing (/fly?u=&c=), which shows the rocket and the inviter's crew, then links to the rocket.
 */
import { NextResponse, type NextRequest } from "next/server";
import { REF_COOKIE, REF_TTL_MS, parseRef } from "@/lib/referral";
import { resolveFly } from "@/lib/server/fly";
import { CREW_ENABLED } from "@/lib/features";
import { SITE_ORIGIN, isPreviewBot, previewPage } from "@/lib/server/og/botPage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ user: string; coin: string }> }) {
  const { user, coin } = await params;
  const r = await resolveFly(user, coin).catch(() => null);
  // Crew off (until after launch): the invite still credits the inviter, then opens the rocket itself.
  const to = new URL(!r ? "/" : CREW_ENABLED ? `/fly?u=${encodeURIComponent(r.username ?? r.wallet)}&c=${r.view.coin}` : `/coin/${r.view.coin}`, req.url);
  if (isPreviewBot(req.headers.get("user-agent"))) {
    const o = SITE_ORIGIN;
    return previewPage({
      title: r ? `@${r.view.inviter} invited you to fly $${r.view.ticker}` : "You're invited to DISCIPLE", description: "Every coin is a rocket. Real coin, real money.",
      image: `${o}/api/og/invite${r?.username ? `?from=${encodeURIComponent(r.username)}` : ""}`, url: `${o}${req.nextUrl.pathname}`, to: `${o}${to.pathname}${to.search}`,
    });
  }
  const res = NextResponse.redirect(to, 307);
  res.headers.set("cache-control", "private, no-store"); res.headers.set("vary", "User-Agent");
  if (r && !parseRef(req.cookies.get(REF_COOKIE)?.value)) {
    res.cookies.set(REF_COOKIE, JSON.stringify({ u: r.username, a: r.wallet, t: Date.now() }), {
      maxAge: Math.floor(REF_TTL_MS / 1000), path: "/", sameSite: "lax", secure: new URL(req.url).protocol === "https:", httpOnly: false,
    });
  }
  return res;
}

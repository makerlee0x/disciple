/** Invite link: /i/<CODE> → /invite?code=<CODE> (the page saves it and asks the player to sign in and use it). */
import { NextResponse, type NextRequest } from "next/server";
import { normCode } from "@/lib/server/invites";
import { SITE_ORIGIN, isPreviewBot, previewPage } from "@/lib/server/og/botPage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = normCode(decodeURIComponent(raw || ""));
  const to = new URL("/invite", req.url);
  if (code) to.searchParams.set("code", code);
  // link preview crawlers get the invite card; the code itself is never drawn on it
  if (isPreviewBot(req.headers.get("user-agent"))) {
    const o = SITE_ORIGIN;
    return previewPage({ title: "You're invited to DISCIPLE", description: "Take your seat and boost your first rocket.", image: `${o}/api/og/invite`, url: `${o}/i/${code ?? ""}`, to: `${o}/invite${code ? `?code=${code}` : ""}` });
  }
  const res = NextResponse.redirect(to, 307);
  res.headers.set("cache-control", "private, no-store"); res.headers.set("vary", "User-Agent");
  return res;
}

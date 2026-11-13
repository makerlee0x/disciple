/** Invite link: /i/<CODE> → /invite?code=<CODE> (the page saves it and asks the player to sign in and use it). */
import { NextResponse, type NextRequest } from "next/server";
import { normCode } from "@/lib/server/invites";
import { isPreviewBot, previewPage } from "@/lib/server/og/botPage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = normCode(decodeURIComponent(raw || ""));
  const to = new URL("/invite", req.url);
  if (code) to.searchParams.set("code", code);
  // link preview crawlers get the invite card; the code itself is never drawn on it
  if (isPreviewBot(req.headers.get("user-agent"))) {
    const o = new URL(req.url).origin;
    return previewPage({ title: "You're invited to DISCIPLE", description: "Take your seat and boost your first rocket.", image: `${o}/api/og/invite`, url: req.url, to: to.toString() });
  }
  return NextResponse.redirect(to, 307);
}

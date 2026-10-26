/** Invite link: /i/<CODE> → /invite?code=<CODE> (the page saves it and asks the player to sign in and use it). */
import { NextResponse, type NextRequest } from "next/server";
import { normCode } from "@/lib/server/invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { code: string } }) {
  const code = normCode(decodeURIComponent(params.code || ""));
  const to = new URL("/invite", req.url);
  if (code) to.searchParams.set("code", code);
  return NextResponse.redirect(to, 307);
}

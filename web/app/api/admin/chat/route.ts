export const runtime = "nodejs";
/**
 * Team review of chat reports (lib/server/chat/moderation). Privy session whose email is in ADMIN_EMAILS; unset ⇒ 503.
 * GET → { groups }   POST { action: remove|restore|mute|unmute|dismiss, id } → { ok }
 */
import { NextResponse } from "next/server";
import { authenticateAdmin, bearer, privyEnv } from "@/lib/server/privyAuth";
import { listReports, moderate, type ModAction } from "@/lib/server/chat/moderation";

export const dynamic = "force-dynamic";
const json = (s: number, b: unknown) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });
const ACTIONS: ModAction[] = ["remove", "restore", "mute", "unmute", "dismiss"];

export async function GET(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return json(a.status, { error: a.reason });
  return json(200, { groups: (await listReports()).map(({ members: _m, ...g }) => g) });
}
export async function POST(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return json(a.status, { error: a.reason });
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
  if (!ACTIONS.includes(b.action as ModAction) || typeof b.id !== "string") return json(400, { error: "Bad request." });
  const r = await moderate(b.action as ModAction, b.id);
  return json(r.ok ? 200 : 404, r);
}

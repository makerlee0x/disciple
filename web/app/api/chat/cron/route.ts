/** GET (Vercel cron / external pinger): chain catch-up for coins with a subscriber in the last 10 min. Auth: Bearer CRON_SECRET if set. */
import { NextResponse } from "next/server";
import { chatStore } from "@/lib/server/chat/store";
import { catchUp } from "@/lib/server/chat/chain";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (s && req.headers.get("authorization") !== `Bearer ${s}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const coins = await chatStore().activeSince(Date.now() - 10 * 60_000);
  const res: Record<string, number> = {};
  for (const c of coins.slice(0, 25)) res[c] = await catchUp(c);
  return NextResponse.json({ ok: true, store: chatStore().kind, coins: res });
}

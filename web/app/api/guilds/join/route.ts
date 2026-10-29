export const runtime = "nodejs";
/** POST { address, guildId, nonce, signature, owner? } → { ok, guild } · one guild per player; switching is once a day (429 + nextAllowedAt). */
import { NextResponse } from "next/server";
import { guilds } from "@/lib/server/guilds";
import { guildResponse, verifiedGuildAction } from "@/lib/server/guildAuth";
import { isGuildId } from "@/lib/guilds";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const f = (b: { guildId?: unknown }) => ({ guildId: String(b.guildId ?? "") });
  const v = await verifiedGuildAction(req, "join", f);
  if (!v.ok) return v.res;
  const { guildId } = f(v.body);
  if (!isGuildId(guildId)) return NextResponse.json({ ok: false, reason: "Unknown guild." }, { status: 400 });
  if (!(await v.consume())) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  return guildResponse(await guilds().join(v.addr, guildId));
}

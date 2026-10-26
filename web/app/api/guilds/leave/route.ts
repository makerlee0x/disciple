export const runtime = "nodejs";
/** POST { address, nonce, signature, owner? } → { ok, guild: null } · takes effect right away (counts as a switch: once a day). */
import { NextResponse } from "next/server";
import { guilds } from "@/lib/server/guilds";
import { guildResponse, verifiedGuildAction } from "@/lib/server/guildAuth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const v = await verifiedGuildAction(req, "leave", () => ({}));
  if (!v.ok) return v.res;
  if (!(await v.consume())) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  return guildResponse(await guilds().leave(v.addr));
}

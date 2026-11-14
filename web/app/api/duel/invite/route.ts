/** Challenge a friend. POST { tier, len } → { ok, room, code, path } (the code lives 30 min). */
import { isLength, isTier } from "@/lib/duel/rules";
import { createInvite, DuelError } from "@/lib/server/duel/store";
import { body, fail, out, pilotOf } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const me = await pilotOf(req);
    const b = await body<{ tier?: unknown; len?: unknown }>(req);
    if (!isTier(b.tier) || !isLength(b.len)) throw new DuelError(400, "Pick a tier and a length.");
    const room = await createInvite(me, b.tier, b.len);
    return out(200, { ok: true, room, code: room.code, path: `/turbo/duel?c=${room.code}` });
  } catch (e) { return fail(e); }
}

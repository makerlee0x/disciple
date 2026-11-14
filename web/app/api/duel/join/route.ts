/** Join a friend's duel. POST { code } (DUEL-XXXX, XXXX or a pasted link) → { ok, room }. */
import { parseCode } from "@/lib/duel/rules";
import { joinInvite, DuelError } from "@/lib/server/duel/store";
import { body, fail, out, pilotOf } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const me = await pilotOf(req);
    const code = parseCode((await body<{ code?: unknown }>(req)).code);
    if (!code) throw new DuelError(400, "That code doesn't look right.");
    return out(200, { ok: true, room: await joinInvite(me, code) });
  } catch (e) { return fail(e); }
}

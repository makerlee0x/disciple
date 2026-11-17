/** Rematch request (maker 2026-11-16). POST { to, code } → { ok, sent }. `to` is a username or wallet (the /vs/<pilot> slug),
 *  `code` is the sender's own open friend room. The pilot gets a "duel" push (lib/push) that opens that room. Once per
 *  sender → pilot per hour (the push event key), and the usual 3-a-day push cap. Signed-in senders only: a request names
 *  who's asking, so a guest can't send one. */
import { DuelError } from "@/lib/server/duel/store";
import { activeRoomOf } from "@/lib/server/duel/store";
import { body, fail, out, pilotOf } from "@/lib/server/duel/http";
import { challengerOf } from "@/lib/server/duel/challenge";
import { notify } from "@/lib/server/push";
import { pushCopy } from "@/lib/push";
import { parseCode } from "@/lib/duel/rules";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const me = await pilotOf(req, { guestOk: false });
    const b = await body<{ to?: unknown; code?: unknown }>(req);
    const code = parseCode(typeof b.code === "string" ? b.code : null);
    if (typeof b.to !== "string" || !code) throw new DuelError(400, "Pick a pilot and open a duel first.");
    const them = await challengerOf(b.to);
    if (!them) throw new DuelError(404, "No pilot by that name.");
    if (them.pid === me.pid) throw new DuelError(400, "You can't duel yourself.");
    const room = await activeRoomOf(me.pid);
    if (!room || room.code !== code || room.status !== "lobby") throw new DuelError(409, "Your duel room closed. Open a new one.");
    const copy = pushCopy.duel(me.name);
    const sent = await notify(them.pid, "duel", `duelreq:${me.pid}:${Math.floor(Date.now() / 3_600_000)}`, { ...copy, url: `/turbo/duel?c=${code}&ref=${me.pid}` });
    return out(200, { ok: true, sent });
  } catch (e) { return fail(e, req); }
}

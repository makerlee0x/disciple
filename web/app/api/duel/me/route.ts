/** GET → { ok, pid, name, rating, active } for the lobby header (and to rejoin a duel after a reload). */
import { activeRoomOf, ratingOf } from "@/lib/server/duel/store";
import { fail, out, pilotOf } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await pilotOf(req);
    return out(200, { ok: true, pid: me.pid, name: me.name, rating: await ratingOf(me.pid), active: await activeRoomOf(me.pid) });
  } catch (e) { return fail(e); }
}

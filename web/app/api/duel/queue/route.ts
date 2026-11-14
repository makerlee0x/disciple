/**
 * Ranked quick match. POST { tier, len } = one poll (call every ~1.5 s while searching) → { ok, room } once paired,
 * else { ok, waitedMs, window, botOfferMs }. DELETE { tier, len } leaves the queue. Signed-in pilots only.
 */
import { BOT_OFFER_MS, isLength, isTier } from "@/lib/duel/rules";
import { activeRoomOf, leaveQueue, pollQueue, DuelError } from "@/lib/server/duel/store";
import { body, fail, out, pilotOf } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const me = await pilotOf(req);
    const b = await body<{ tier?: unknown; len?: unknown }>(req);
    if (!isTier(b.tier) || !isLength(b.len)) throw new DuelError(400, "Pick a tier and a length.");
    const busy = await activeRoomOf(me.pid);
    if (busy && busy.status === "live") return out(200, { ok: true, room: busy });
    const r = await pollQueue(me, b.tier, b.len);
    return out(200, { ok: true, ...r, botOfferMs: BOT_OFFER_MS });
  } catch (e) { return fail(e); }
}
export async function DELETE(req: Request) {
  try {
    const me = await pilotOf(req);
    const b = await body<{ tier?: unknown; len?: unknown }>(req);
    if (isTier(b.tier) && isLength(b.len)) await leaveQueue(me.pid, b.tier, b.len);
    return out(200, { ok: true });
  } catch (e) { return fail(e); }
}

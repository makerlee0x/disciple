/** Challenge a friend. POST { tier, len, fuel? } → { ok, room, code, path, share } (the code lives 30 min; `share` is the
 *  permanent /vs/<pilot> challenge link for posts, which outlives the code, lib/server/duel/challenge). fuel = a custom budget
 *  in whole dollars ($10–$10,000, lib/duel/rules); left out, the tier's fuel. */
import { CUSTOM_FUEL_MAX, CUSTOM_FUEL_MIN, isCustomFuel, toLength, isTier } from "@/lib/duel/rules";
import { createInvite, DuelError } from "@/lib/server/duel/store";
import { body, fail, out, pilotOf } from "@/lib/server/duel/http";
import { challengePath } from "@/lib/server/duel/challenge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const me = await pilotOf(req);
    const b = await body<{ tier?: unknown; len?: unknown; fuel?: unknown }>(req);
    const len = toLength(b.len);
    if (!isTier(b.tier) || !len) throw new DuelError(400, "Pick a tier and a length.");
    if (b.fuel != null && !isCustomFuel(b.fuel)) throw new DuelError(400, `Pick a budget from $${CUSTOM_FUEL_MIN} to $${CUSTOM_FUEL_MAX.toLocaleString("en-US")}.`);
    const room = await createInvite(me, b.tier, len, undefined, b.fuel ?? undefined);
    const guest = req.headers.get("x-duel-guest") === "1";
    // signed-in pilots are wallets: their links carry ?ref= so a friend they bring in counts as their referral
    const ref = !guest && /^0x[0-9a-f]{40}$/.test(me.pid) ? `&ref=${me.pid}` : "";
    const share = guest ? null : challengePath({ pid: me.pid, name: me.name, code: room.code });
    return out(200, { ok: true, room, code: room.code, path: `${guest ? "/duel" : "/turbo/duel"}?c=${room.code}${ref}`, share });
  } catch (e) { return fail(e, req); }
}

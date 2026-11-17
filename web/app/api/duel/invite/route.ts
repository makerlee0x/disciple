/** Challenge a friend. POST { tier, len, fuel? } → { ok, room, code, path } (the code lives 30 min). fuel = a custom budget
 *  in whole dollars ($10–$10,000, lib/duel/rules); left out, the tier's fuel. */
import { CUSTOM_FUEL_MAX, CUSTOM_FUEL_MIN, isCustomFuel, toLength, isTier } from "@/lib/duel/rules";
import { createInvite, DuelError } from "@/lib/server/duel/store";
import { body, fail, out, pilotOf } from "@/lib/server/duel/http";
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
    return out(200, { ok: true, room, code: room.code, path: `${req.headers.get("x-duel-guest") === "1" ? "/duel" : "/turbo/duel"}?c=${room.code}` });
  } catch (e) { return fail(e, req); }
}

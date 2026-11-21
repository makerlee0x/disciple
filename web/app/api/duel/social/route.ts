/** Duel friends and rivals (lib/server/duel/social). GET → { ok, friends, rivals }. POST { op: "add" | "remove", who } where `who`
 *  is a username (with or without @) or a wallet → { ok, added? }. Signed-in pilots only. */
import { DuelError } from "@/lib/server/duel/store";
import { body, fail, out, pilotOf } from "@/lib/server/duel/http";
import { challengerOf } from "@/lib/server/duel/challenge";
import { addFriend, removeFriend, socialOf } from "@/lib/server/duel/social";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await pilotOf(req, { guestOk: false });
    return out(200, { ok: true, ...(await socialOf(me.pid)) });
  } catch (e) { return fail(e); }
}

export async function POST(req: Request) {
  try {
    const me = await pilotOf(req, { guestOk: false });
    const b = await body<{ op?: unknown; who?: unknown }>(req);
    if ((b.op !== "add" && b.op !== "remove") || typeof b.who !== "string" || !b.who.trim()) throw new DuelError(400, "Pick a pilot.");
    const raw = b.who.trim();
    if (b.op === "remove" && /^0x[0-9a-fA-F]{40}$/.test(raw)) { await removeFriend(me.pid, raw.toLowerCase()); return out(200, { ok: true }); }
    const them = await challengerOf(raw);
    if (!them) throw new DuelError(404, "No pilot by that name.");
    if (b.op === "remove") { await removeFriend(me.pid, them.pid); return out(200, { ok: true }); }
    return out(200, { ok: true, ...(await addFriend(me.pid, them.pid)) });
  } catch (e) { return fail(e); }
}

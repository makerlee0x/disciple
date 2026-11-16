/** POST → { ok, pid, name }: a guest pilot for the duel-only demo page (/duel). Needs the Turbo pass (or a live friend
 *  invite); keeps the guest cookie it already has, otherwise mints one (lib/server/duelGuest). Rate limited per IP. */
import { cookies } from "next/headers";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { DuelError } from "@/lib/server/duel/store";
import { fail, out, requirePass } from "@/lib/server/duel/http";
import { DUEL_GUEST_COOKIE, DUEL_GUEST_MAX_AGE, guestFromReq, guestName, guestToken, newGuestId } from "@/lib/server/duelGuest";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    requirePass(req);
    let pid = await guestFromReq(req);
    if (!pid) {
      if (!(await hitLimit(kv(), `duel:guest:ip:${clientIp(req.headers)}`, 30, 3600)).ok) throw new DuelError(429, "Slow down a little.");
      pid = newGuestId();
    }
    (await cookies()).set(DUEL_GUEST_COOKIE, await guestToken(pid), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: DUEL_GUEST_MAX_AGE });
    return out(200, { ok: true, pid, name: guestName(pid) });
  } catch (e) { return fail(e); }
}

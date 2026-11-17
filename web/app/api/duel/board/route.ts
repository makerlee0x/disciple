/** GET /api/duel/board[?me=0x…][&board=season] → { ok, rows, total, me[, season] }: ranked Trading Duel ratings, highest first (lib/server/duel/store duelBoard). Behind the Turbo pass until launch. */
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { duelBoard, seasonBoard, DuelError } from "@/lib/server/duel/store";
import { fail, out, requirePass } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const rl = await hitLimit(kv(), `duel:board:ip:${clientIp(req.headers)}`, 60, 60);
    if (!rl.ok) throw new DuelError(429, "Slow down a little.");
    requirePass(req);
    const me = new URL(req.url).searchParams.get("me");
    if (me !== null && !/^0x[0-9a-fA-F]{40}$/.test(me)) throw new DuelError(400, "bad me");
    // ?board=season: this month's ladder by season points (lib/duel/season)
    if (new URL(req.url).searchParams.get("board") === "season") return out(200, { ok: true, ...(await seasonBoard(50, me ? me.toLowerCase() : null)) });
    return out(200, { ok: true, ...(await duelBoard(50, me ? me.toLowerCase() : null)) });
  } catch (e) { return fail(e); }
}

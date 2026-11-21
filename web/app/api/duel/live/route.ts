/**
 * GET /api/duel/live → { ok, duels: LiveDuel[], price, now }: the online duels on right now, for the Watch screen
 * (/turbo/watch). Public like GET /api/duel/room/[id]; friend rooms stay off the list. One KV read per instance a second.
 */
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { duelPrice } from "@/lib/server/duel/price";
import { liveDuels, DuelError, type LiveDuel } from "@/lib/server/duel/store";
import { fail, out, requirePass } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __dscLiveDuels?: { at: number; v: { duels: LiveDuel[]; price: number | null } } };

export async function GET(req: Request) {
  try {
    requirePass(req);
    const rl = await hitLimit(kv(), `duel:live:${clientIp(req.headers)}`, 60, 60);
    if (!rl.ok) throw new DuelError(429, "Slow down a little.");
    let c = g.__dscLiveDuels;
    if (!c || Date.now() - c.at > 1000) {
      const price = await duelPrice().catch(() => null);
      c = { at: Date.now(), v: { duels: await liveDuels(price), price } };
      g.__dscLiveDuels = c;
    }
    return out(200, { ok: true, ...c.v, now: Date.now() });
  } catch (e) { return fail(e, req); }
}

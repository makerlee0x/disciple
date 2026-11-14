/**
 * One duel room.
 * GET ?after=<seq> → { ok, room, events, now }  (anyone with the room id; also runs the H-BOMB / buzzer check)
 * POST { op } as a seated, signed-in pilot:
 *   ready · leave · rematch
 *   trade { action: boost|dump|close, usd }   fills at the server's live price
 *   chat { text }                              filtered (links stripped, profanity masked), 60 chars, rate limited
 *   trick { kind: spin|flip }
 * → { ok, room, events, now }
 */
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { filterText } from "@/lib/chat/filter";
import { DUEL_CHAT_MAX } from "@/lib/duel/types";
import { duelPrice } from "@/lib/server/duel/price";
import { chat, eventsAfter, getRoom, leave, rematch, setReady, tick, trade, trick, DuelError } from "@/lib/server/duel/store";
import { body, fail, out, pilotOf, requirePass } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: P) {
  try {
    requirePass(req);
    const rl = await hitLimit(kv(), `duel:get:${clientIp(req.headers)}`, 240, 60);
    if (!rl.ok) throw new DuelError(429, "Slow down a little.");
    const { id } = await params;
    let room = await getRoom(id); if (!room) throw new DuelError(404, "That duel is gone.");
    if (room.status === "live") { const t = await tick(id, await duelPrice()); if (t) room = t.room; }
    const after = Number(new URL(req.url).searchParams.get("after")) || 0;
    return out(200, { ok: true, room, events: await eventsAfter(id, after), now: Date.now() });
  } catch (e) { return fail(e); }
}

export async function POST(req: Request, { params }: P) {
  try {
    const me = await pilotOf(req);
    const { id } = await params;
    const b = await body<{ op?: unknown; action?: unknown; usd?: unknown; text?: unknown; kind?: unknown; after?: unknown }>(req);
    let res;
    switch (b.op) {
      case "ready": res = await setReady(id, me.pid); break;
      case "leave": res = await leave(id, me.pid); break;
      case "rematch": res = await rematch(id, me.pid); break;
      case "trade": {
        const action = b.action, usd = Number(b.usd);
        if (action !== "boost" && action !== "dump" && action !== "close") throw new DuelError(400, "Bad trade.");
        const rl = await hitLimit(kv(), `duel:trade:${me.pid}`, 40, 10);
        if (!rl.ok) throw new DuelError(429, "Too many trades at once.");
        res = await trade(id, me.pid, action, Number.isFinite(usd) ? usd : 0, await duelPrice());
        break;
      }
      case "chat": {
        const raw = String(b.text ?? "");
        if (Array.from(raw.trim()).length > DUEL_CHAT_MAX) throw new DuelError(400, "Keep it under 60 characters.");
        const f = filterText(raw); if (!f.ok) throw new DuelError(400, "Couldn't send that.");
        const rl = await hitLimit(kv(), `duel:chat:${me.pid}`, 6, 10);
        if (!rl.ok) throw new DuelError(429, "Easy on the chat.");
        res = await chat(id, me.pid, f.text); break;
      }
      case "trick": {
        if (b.kind !== "spin" && b.kind !== "flip") throw new DuelError(400, "Bad trick.");
        const rl = await hitLimit(kv(), `duel:trick:${me.pid}`, 6, 10);
        if (!rl.ok) return out(200, { ok: true });
        res = await trick(id, me.pid, b.kind); break;
      }
      default: throw new DuelError(400, "Unknown op.");
    }
    const after = Number(b.after) || 0;
    return out(200, { ok: true, room: res.room, events: await eventsAfter(id, after), now: Date.now() });
  } catch (e) { return fail(e); }
}

/**
 * GET ?after=<seq>  Server-Sent Events for one duel (same pattern as /api/chat/stream): polls the room's event log
 * every 250 ms while live (1 s otherwise), runs the H-BOMB / buzzer check once a second, closes after ~50 s and the
 * EventSource reconnects with Last-Event-ID (= seq). Events: `event: ev` data DuelEvent · `event: price` {p, ts} · pings.
 */
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { duelPrice } from "@/lib/server/duel/price";
import { eventsAfter, getRoom, tick } from "@/lib/server/duel/store";
import { requirePass } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const LIFETIME_MS = 50_000;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { requirePass(req); } catch { return new Response("closed", { status: 403 }); }
  const rl = await hitLimit(kv(), `duel:sse:${clientIp(req.headers)}`, 60, 60);
  if (!rl.ok) return new Response("rate limited", { status: 429 });
  const { id } = await params;
  if (!(await getRoom(id))) return new Response("gone", { status: 404 });
  let cursor = Number(req.headers.get("last-event-id") || new URL(req.url).searchParams.get("after")) || 0;
  const enc = new TextEncoder(); let closed = false;
  req.signal.addEventListener("abort", () => { closed = true; });
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const write = (s: string) => { if (!closed) try { ctl.enqueue(enc.encode(s)); } catch { closed = true; } };
      write("retry: 1000\n: live\n\n");
      const t0 = Date.now(); let lastTick = 0, lastPing = Date.now();
      while (!closed && Date.now() - t0 < LIFETIME_MS) {
        const room = await getRoom(id).catch(() => null);
        if (!room) break;
        const now = Date.now();
        if (room.status === "live" && now - lastTick > 1000) {
          lastTick = now;
          const p = await duelPrice();
          if (p) { write(`event: price\ndata: ${JSON.stringify({ p, ts: now })}\n\n`); await tick(id, p).catch(() => null); }
        }
        for (const e of await eventsAfter(id, cursor).catch(() => [])) { cursor = e.seq; write(`id: ${e.seq}\nevent: ev\ndata: ${JSON.stringify(e)}\n\n`); }
        if (room.status === "done" || room.status === "cancelled") { if (Date.now() - t0 > 2000) break; }
        if (now - lastPing > 15_000) { lastPing = now; write(": ping\n\n"); }
        await new Promise((r) => setTimeout(r, room.status === "live" ? 250 : 1000));
      }
      closed = true; try { ctl.close(); } catch { /* closed */ }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}

/**
 * GET ?after=<seq>  Server-Sent Events for one duel (same pattern as /api/chat/stream): polls the room's event log
 * every 250 ms while live (1 s otherwise), runs the NUKE / buzzer check once a second, closes after ~50 s and the
 * EventSource reconnects with Last-Event-ID (= seq). Events: `event: ev` data DuelEvent · `event: price` {p, ts} · pings.
 */
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { duelPrice } from "@/lib/server/duel/price";
import { after } from "next/server";
import { eventsAfter, getRoom, referee, refereeRunning } from "@/lib/server/duel/store";
import { requirePass } from "@/lib/server/duel/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const LIFETIME_MS = 50_000;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { requirePass(req); } catch { return new Response("closed", { status: 403 }); }
  const rl = await hitLimit(kv(), `duel:sse:${clientIp(req.headers)}`, 60, 60);
  if (!rl.ok) return new Response("rate limited", { status: 429 });
  const { id } = await params;
  const r0 = await getRoom(id);
  if (!r0) return new Response("gone", { status: 404 });
  // a finished room has nothing to stream: 204 tells EventSource to stop reconnecting (it used to reconnect every ~3 s
  // for as long as a result screen stayed open, which burned the KV request quota)
  if (r0.status === "done" || r0.status === "cancelled") return new Response(null, { status: 204 });
  if (r0.status === "live" && !(await refereeRunning(id))) after(() => referee(id, duelPrice));
  let cursor = Number(req.headers.get("last-event-id") || new URL(req.url).searchParams.get("after")) || 0;
  const enc = new TextEncoder(); let closed = false;
  req.signal.addEventListener("abort", () => { closed = true; });
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const write = (s: string) => { if (!closed) try { ctl.enqueue(enc.encode(s)); } catch { closed = true; } };
      write("retry: 1000\n: live\n\n");
      // KV budget (2026-11-16, Upstash cap hit): the referee alone ticks the room (streams no longer do), events are read
      // every 500 ms while live (1.5 s in the lobby), and the room itself only every 2 s or when an event arrives.
      const t0 = Date.now(); let lastPrice = 0, lastPing = Date.now(), lastRoom = 0, lastRef = Date.now(), room = r0;
      while (!closed && Date.now() - t0 < LIFETIME_MS) {
        const now = Date.now();
        const evs = await eventsAfter(id, cursor).catch(() => []);
        for (const e of evs) { cursor = e.seq; write(`id: ${e.seq}\nevent: ev\ndata: ${JSON.stringify(e)}\n\n`); }
        if (evs.length || now - lastRoom > 2000) { const r = await getRoom(id).catch(() => null); if (!r) break; room = r; lastRoom = now; }
        if (room.status === "done" || room.status === "cancelled") { write("event: end\ndata: {}\n\n"); break; }
        if (room.status === "live" && now - lastPrice > 1000) {
          lastPrice = now;
          const p = await duelPrice();
          if (p) write(`event: price\ndata: ${JSON.stringify({ p, ts: now })}\n\n`);
        }
        if (room.status === "live" && now - lastRef > 5000) { lastRef = now; if (!(await refereeRunning(id).catch(() => true))) void referee(id, duelPrice).catch(() => null); }
        if (now - lastPing > 15_000) { lastPing = now; write(": ping\n\n"); }
        await new Promise((r) => setTimeout(r, room.status === "live" ? 500 : 1500));
      }
      closed = true; try { ctl.close(); } catch { /* closed */ }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}

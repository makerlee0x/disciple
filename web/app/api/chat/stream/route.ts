/**
 * GET ?coin=0x…  Server-Sent Events. Polls the store every 800ms and runs chain catch-up every ~3s.
 * Closes after ~50s (Vercel function limit); EventSource reconnects with Last-Event-ID and the client dedupes by id.
 * Events: `event: msg` data ChatMsg (id: ulid) · `: ping` comments every 15s.
 */
import { chatStore, historyOf, messagesAfter } from "@/lib/server/chat/store";
import { catchUp } from "@/lib/server/chat/chain";
import { isCoin } from "@/lib/chat/types";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const LIFETIME_MS = 50_000, POLL_MS = 800, CHAIN_MS = 3000, PING_MS = 15_000;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `chatread:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.chatReadPerIp.limit, PUBLIC_GET_LIMITS.chatReadPerIp.windowSec);
  if (!rl.ok) return new Response("rate limited", { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const u = new URL(req.url);
  const coin = (u.searchParams.get("coin") || "").toLowerCase();
  if (!isCoin(coin)) return new Response("bad coin", { status: 400 });
  const chain = u.searchParams.get("chain") !== "0";
  const lastId = req.headers.get("last-event-id") || u.searchParams.get("after") || "";
  const st = chatStore();
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener("abort", () => { closed = true; });

  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const write = (s: string) => { if (!closed) try { ctl.enqueue(enc.encode(s)); } catch { closed = true; } };
      const sent = new Set<string>();
      // Cursor: resume after Last-Event-ID, else start at the newest existing message (history() covers the past).
      let cursor = lastId;
      if (!cursor) { const h = await historyOf(coin, 1); cursor = h.length ? h[h.length - 1].id : ""; }
      write(`retry: 1500\n: live\n\n`);
      const t0 = Date.now(); let lastChain = 0, lastPing = Date.now();
      while (!closed && Date.now() - t0 < LIFETIME_MS) {
        const now = Date.now();
        if (chain && now - lastChain > CHAIN_MS) {
          lastChain = now;
          st.touchActive(coin, now).catch(() => {});
          await catchUp(coin);
        }
        try {
          // `cursor` is a fixed floor; the `sent` set dedupes, so late writes with a slightly older ulid (clock skew between lambdas) still go out.
          const msgs = await messagesAfter(coin, cursor);
          for (const m of msgs) {
            if (sent.has(m.id)) continue;
            sent.add(m.id);
            write(`id: ${m.id}\nevent: msg\ndata: ${JSON.stringify(m)}\n\n`);
          }
        } catch (e) { write(`: error ${(e as Error).message.replace(/\n/g, " ")}\n\n`); }
        if (now - lastPing > PING_MS) { lastPing = now; write(`: ping\n\n`); }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      closed = true;
      try { ctl.close(); } catch { /* already closed */ }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

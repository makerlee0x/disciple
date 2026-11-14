/**
 * GET ?coin=0x…  Server-Sent Events. Polls the store every 800ms and runs chain catch-up every ~3s.
 * Closes after ~50s (Vercel function limit); EventSource reconnects with Last-Event-ID and the client dedupes by id.
 * Events: `event: msg` data ChatMsg (id: ulid) · `: ping` comments every 15s.
 */
import { chatStore, historyOf, messagesAfter } from "@/lib/server/chat/store";
import { catchUp } from "@/lib/server/chat/chain";
import { isCoin, type ChatMsg } from "@/lib/chat/types";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const LIFETIME_MS = 50_000, POLL_MS = 800, CHAIN_MS = 3000, PING_MS = 15_000;

/* Speed pass (2026-11-14): every open flight held one of these streams, and each one read the coin's last 100 messages from
   KV every 800 ms and ran the chain catch-up (lock, RPC block number + getLogs, ZADD) every 3 s, so the cost grew with
   viewers, not with chat activity. Streams for the same coin on one server instance now share one store read per
   SHARED_READ_MS and one chain step per CHAIN_MS (catchUp's own lock still keeps instances from overlapping). Messages
   still arrive within POLL_MS + SHARED_READ_MS. */
const SHARED_READ_MS = 400;
const reads = new Map<string, { t: number; p: Promise<ChatMsg[]> }>();
function sharedRecent(coin: string): Promise<ChatMsg[]> {
  const now = Date.now(), hit = reads.get(coin);
  if (hit && now - hit.t < SHARED_READ_MS) return hit.p;
  const p = messagesAfter(coin, "");
  reads.set(coin, { t: now, p });
  p.catch(() => { if (reads.get(coin)?.p === p) reads.delete(coin); });
  if (reads.size > 500) for (const [k, v] of reads) if (now - v.t > 5_000) reads.delete(k);
  return p;
}
const chainAt = new Map<string, number>();
function chainStepDue(coin: string, now: number): boolean {
  if (now - (chainAt.get(coin) ?? 0) < CHAIN_MS) return false;
  chainAt.set(coin, now);
  if (chainAt.size > 500) for (const [k, t] of chainAt) if (now - t > 60_000) chainAt.delete(k);
  return true;
}

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
          if (chainStepDue(coin, now)) {
            st.touchActive(coin, now).catch(() => {});
            await catchUp(coin);
          }
        }
        try {
          // `cursor` is a fixed floor; the `sent` set dedupes, so late writes with a slightly older ulid (clock skew between lambdas) still go out.
          const msgs = (await sharedRecent(coin)).filter((m) => m.id > cursor);
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

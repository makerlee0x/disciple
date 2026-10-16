/**
 * Local mock of the DiscipleChat API (no server, no wallet). Same signatures as ./client.
 * Cross-tab via BroadcastChannel; emits a fake buy/sell event line every few seconds while subscribed.
 *   import { DiscipleChatMock, installMock } from "@/lib/chat/mock"; installMock(); // window.DiscipleChat = mock
 */
import { EMOTES } from "./emotes";
import { filterText } from "./filter";
import { take, type Bucket } from "./ratelimit";
import { ulid } from "./ulid";
import type { ChatMsg, ChatState, SendResult } from "./types";

const ME = "0x000000000000000000000000000000000000beef";
const logs = new Map<string, ChatMsg[]>();
const subs = new Map<string, Set<(m: ChatMsg) => void>>();
let bucket: Bucket | null = null;
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("disciple-chat-mock") : null;
function push(m: ChatMsg, local = true) {
  const l = logs.get(m.coin) ?? []; l.push(m); if (l.length > 200) l.shift(); logs.set(m.coin, l);
  subs.get(m.coin)?.forEach((f) => f(m));
  if (local) bc?.postMessage(m);
}
if (bc) bc.onmessage = (e) => push(e.data as ChatMsg, false);

export async function history(coin: string, opts: { limit?: number; before?: string } = {}): Promise<ChatMsg[]> {
  const l = (logs.get(coin.toLowerCase()) ?? []).filter((m) => !opts.before || m.id < opts.before);
  return l.slice(-(opts.limit ?? 50));
}
export function subscribe(coin: string, onMsg: (m: ChatMsg) => void, opts: { onState?: (s: ChatState) => void } = {}) {
  const c = coin.toLowerCase();
  const set = subs.get(c) ?? new Set(); set.add(onMsg); subs.set(c, set);
  opts.onState?.("connecting"); setTimeout(() => opts.onState?.("live"), 50);
  const iv = setInterval(() => {
    const isBuy = Math.random() > 0.4, bps = Math.round(Math.random() ** 3 * 7000), usd = Math.round(Math.random() * 500);
    push({ id: ulid(), coin: c, kind: "event", from: { addr: "0x" + Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40) }, ts: Date.now(),
      text: `trader ${isBuy ? "bought" : "sold"} $${usd} (${isBuy ? "+" : "-"}${(bps / 100).toFixed(1)}%)`, meta: { event: isBuy ? "buy" : "sell", usd, impactBps: isBuy ? bps : -bps, tx: "0xmock" } });
  }, 4000);
  return () => { set.delete(onMsg); clearInterval(iv); opts.onState?.("closed"); };
}
export async function send(coin: string, text: string): Promise<SendResult> {
  const f = filterText(text); if (!f.ok) return { ok: false, error: f.error };
  const r = take(bucket, Date.now()); bucket = r.bucket;
  if (!r.ok) return { ok: false, error: "rate_limited", retryAfterMs: r.retryAfterMs };
  const msg: ChatMsg = { id: ulid(), coin: coin.toLowerCase(), kind: "user", from: { addr: ME, name: "mock_disciple", badge: "believer", prestige: 3 }, text: f.text, ts: Date.now() };
  push(msg); return { ok: true, msg };
}
export async function login() { return { token: "mock", exp: Date.now() + 3600_000, addr: ME }; }
export function logout() { /* noop */ }
export const DiscipleChatMock = { history, subscribe, send, login, logout, EMOTES };
export function installMock() { if (typeof window !== "undefined") (window as unknown as { DiscipleChat: typeof DiscipleChatMock }).DiscipleChat = DiscipleChatMock; }

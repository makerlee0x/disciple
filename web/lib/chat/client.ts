"use client";
/**
 * DISCIPLE live chat client. The ONLY thing the UI / engine touches; transport (SSE + REST) is hidden here.
 * Also installed as window.DiscipleChat (see components/chat/ChatBridge.tsx) for plain-JS engine code.
 *
 *   history(coin, { limit = 50, before? }) → ChatMsg[] oldest→newest
 *   subscribe(coin, onMsg, { onState? }) → unsubscribe
 *   send(coin, text) → { ok: true, msg } | { ok: false, error, retryAfterMs? }
 *   EMOTES: code → svg url
 *
 * Trade/graduate lines are emitted SERVER-SIDE from chain logs (kind 'event', meta.event 'buy'|'sell'|'graduate',
 * meta.impactBps signed: + buy, − sell). There is no client postEvent.
 * Identity: first send() asks the connected smart account / wallet to sign one message; token cached per tab.
 */
import { withBase } from "@/lib/base-path";
import { chatLoginMessage } from "./login";
import { EMOTES } from "./emotes";
import type { ChatMsg, ChatState, SendResult } from "./types";

export type { ChatMsg, ChatState, SendResult } from "./types";
export { EMOTES };

const api = (p: string) => withBase(`/api/chat/${p}`);
const lc = (c: string) => String(c).toLowerCase();
const TOK_KEY = "disciple.chat.token";

export async function history(coin: string, opts: { limit?: number; before?: string } = {}): Promise<ChatMsg[]> {
  const q = new URLSearchParams({ coin: lc(coin), limit: String(opts.limit ?? 50) });
  if (opts.before) q.set("before", opts.before);
  const r = await fetch(`${api("history")}?${q}`, { cache: "no-store" });
  if (!r.ok) return [];
  return ((await r.json()) as { messages: ChatMsg[] }).messages;
}

export function subscribe(coin: string, onMsg: (m: ChatMsg) => void, opts: { onState?: (s: ChatState) => void } = {}): () => void {
  const seen = new Set<string>();
  let es: EventSource | null = null, stopped = false, lastId = "", wasLive = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const state = (s: ChatState) => { try { opts.onState?.(s); } catch { /* ui */ } };
  const open = () => {
    if (stopped) return;
    state(wasLive ? "reconnecting" : "connecting");
    const q = new URLSearchParams({ coin: lc(coin) }); if (lastId) q.set("after", lastId);
    es = new EventSource(`${api("stream")}?${q}`);
    es.onopen = () => { wasLive = true; state("live"); };
    es.addEventListener("msg", (ev) => {
      const m = JSON.parse((ev as MessageEvent).data) as ChatMsg;
      if (seen.has(m.id)) return;
      seen.add(m.id); if (seen.size > 1000) seen.delete(seen.values().next().value as string);
      if (m.id > lastId) lastId = m.id;
      try { onMsg(m); } catch (e) { console.error(e); }
    });
    // Server closes every ~50s (Vercel limit). Reopen ourselves so we control `after` + state.
    es.onerror = () => { es?.close(); es = null; if (stopped) return; state("reconnecting"); timer = setTimeout(open, wasLive ? 300 : 2000); };
  };
  open();
  return () => { stopped = true; if (timer) clearTimeout(timer); es?.close(); state("closed"); };
}

type Tok = { token: string; exp: number; addr: string };
function cachedToken(addr: string): Tok | null {
  try { const t = JSON.parse(sessionStorage.getItem(TOK_KEY) || "null") as Tok | null; return t && t.addr === addr && t.exp > Date.now() + 60_000 ? t : null; } catch { return null; }
}
/** Sign in (one signature per session). Returns null if no wallet/smart account is connected or the user declines. */
export async function login(): Promise<Tok | null> {
  const w = await import("@/lib/wallet");
  const s = await import("@/lib/aa/session");
  const smart = await s.aaAddress().catch(() => null);
  const addr = lc(smart || w.connectedAddress() || "");
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
  const hit = cachedToken(addr); if (hit) return hit;
  const ts = Date.now();
  const msg = chatLoginMessage(addr, ts);
  let body: Record<string, unknown>;
  try {
    if (smart) {
      const o = await s.aaSignMessage(msg);
      if (!o) return null;
      body = { addr, ts, sig: o.sig, owner: o.owner };
    } else {
      const signer = await w.getSigner();
      body = { addr, ts, sig: await signer.signMessage({ account: signer.account.address, message: msg }) };
    }
  } catch { return null; }
  const r = await fetch(api("auth"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return null;
  const t = (await r.json()) as Tok;
  try { sessionStorage.setItem(TOK_KEY, JSON.stringify(t)); } catch { /* private mode */ }
  return t;
}
export function logout() { try { sessionStorage.removeItem(TOK_KEY); } catch { /* */ } }

export async function send(coin: string, text: string): Promise<SendResult> {
  if (Array.from(String(text)).length > 200) return { ok: false, error: "too_long" };
  const t = await login().catch(() => null);
  if (!t) return { ok: false, error: "no_identity" };
  const r = await fetch(api("send"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` }, body: JSON.stringify({ coin: lc(coin), text }) });
  if (r.status === 401) logout();
  const j = (await r.json().catch(() => null)) as SendResult | null;
  return j && "ok" in j ? j : { ok: false, error: "filtered" };
}

export const DiscipleChat = { history, subscribe, send, login, logout, EMOTES };
export type DiscipleChatApi = typeof DiscipleChat;
export function installGlobal(impl: DiscipleChatApi = DiscipleChat) {
  if (typeof window !== "undefined") (window as unknown as { DiscipleChat: DiscipleChatApi }).DiscipleChat = impl;
}

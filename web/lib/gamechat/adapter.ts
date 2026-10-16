/**
 * Thin adapter between the in-game chat overlay and the DISCIPLE SITE chat client (PR #46: web/lib/chat/client.ts,
 * installed as window.DiscipleChat by components/chat/ChatBridge.tsx in app/layout.tsx).
 *
 * This file does NOT import lib/chat (so the overlay compiles on main without #46). It codes against the documented
 * interface below and resolves at runtime:
 *   1. window.DiscipleChat present (real client, or #46's mock with ?chatmock=1) → use it.
 *   2. absent + ?chatmock=1 → a small local fallback mock (chatter + trade events), overlay-only.
 *   3. absent otherwise → null: the overlay stays hidden.
 * ?chatrate=N (with ?chatmock=1) adds N synthetic msgs/s on top (stress / FPS bench only).
 */
export type ChatBadge = "believer" | "trencher" | "bomber" | "creator" | "whale" | "mod";
export type ChatFrom = { addr: string; name?: string; badge?: ChatBadge; prestige?: number };
export type ChatMsg = {
  id: string; coin: string; kind: "user" | "event" | "system"; from: ChatFrom | null; text: string; ts: number;
  meta?: { event?: string; usd?: number; tx?: string; impactBps?: number };
};
export type ChatState = "connecting" | "live" | "reconnecting" | "closed";
export type SendError = "rate_limited" | "filtered" | "too_long" | "no_identity";
export type SendResult = { ok: true; msg: ChatMsg } | { ok: false; error: SendError; retryAfterMs?: number };
export interface ChatApi {
  history(coin: string, o?: { limit?: number; before?: string }): Promise<ChatMsg[]>;
  subscribe(coin: string, onMsg: (m: ChatMsg) => void, o?: { onState?: (s: ChatState) => void }): () => void;
  send(coin: string, text: string): Promise<SendResult>;
  login(): Promise<unknown>;
  logout(): void;
  EMOTES: Record<string, string>;
}
export const MAX_LEN = 200;
export const EMOTE_CODES = ["halo", "rocket", "nuke", "diamond_hands", "wings", "candle", "gold_coin", "skull"];
/** emoji fallback when the svg set (#46: /chat/emotes/*.svg) is not deployed */
export const EMOTE_EMOJI: Record<string, string> = { halo: "😇", rocket: "🚀", nuke: "☢️", diamond_hands: "💎", wings: "🪽", candle: "🕯️", gold_coin: "🪙", skull: "💀" };

declare global { interface Window { DiscipleChat?: ChatApi } }

const q = () => (typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search));
export const isMockRequested = () => q().get("chatmock") === "1";
export const stressRate = () => (isMockRequested() ? Math.max(0, Math.min(200, +(q().get("chatrate") || 0))) : 0);

/** Resolve the chat API (waits briefly for ChatBridge's effect to install the global). */
export async function resolveChat(waitMs = 2500): Promise<{ api: ChatApi; source: "client" | "fallback-mock"; svgEmotes: boolean } | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const g = typeof window !== "undefined" ? window.DiscipleChat : undefined;
    if (g && typeof g.subscribe === "function") return { api: g, source: "client", svgEmotes: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isMockRequested()) return { api: fallbackMock(), source: "fallback-mock", svgEmotes: false };
  return null;
}

// ── fallback mock (only when #46 is not present) ──────────────────────────────────────────────────────
const NAMES = ["halo_hunter", "trench_rat", "moonmathz", "gm_believer", "bombardier", "whale_watch", "paperhands", "degen_angel", "seraph_sam", "ctomaxi", "cherub", "lilbag"];
const BADGES: (ChatBadge | undefined)[] = ["believer", "trencher", "bomber", "creator", "whale", "mod", undefined, undefined, undefined];
const LINES = ["gm :halo:", "send it :rocket::rocket:", "who just nuked lol :skull:", "diamond hands only :diamond_hands:", "LFG to angels :wings:",
  "this chart is cooking :candle:", "bought the dip", "dev is based", "wen graduation", "ser this is a casino", ":gold_coin: :gold_coin: :gold_coin:",
  "holding till seventh heaven", "rug? no rug. trust", "my tramp just filled :halo:", "that wall is thicc", "W", "ngmi if you sold", "@cherub you see that", "ok that was a NUKE :nuke:"];
let seq = 0;
const rid = () => (Date.now().toString(36) + (seq++).toString(36).padStart(4, "0")).padStart(16, "0");
const addrOf = (i: number) => "0x" + ((i * 2654435761) >>> 0).toString(16).padStart(8, "0").repeat(5);
export function synthMsg(coin: string, r = Math.random): ChatMsg {
  if (r() < 0.22) {
    const buy = r() > 0.42, bps = Math.round(r() ** 3 * 7000), usd = Math.round(5 + r() ** 2 * 2500), i = Math.floor(r() * NAMES.length);
    return { id: rid(), coin, kind: "event", from: { addr: addrOf(i), name: NAMES[i] }, ts: Date.now(), text: `${NAMES[i]} ${buy ? "bought" : "sold"} $${usd}`,
      meta: { event: r() < 0.01 ? "graduate" : buy ? "buy" : "sell", usd, impactBps: buy ? bps : -bps, tx: "0xmock" } };
  }
  const i = Math.floor(r() * NAMES.length);
  return { id: rid(), coin, kind: "user", from: { addr: addrOf(i), name: NAMES[i], badge: BADGES[i % BADGES.length], prestige: i % 4 === 0 ? 1 + (i % 7) : 0 }, ts: Date.now(), text: LINES[Math.floor(r() * LINES.length)] };
}
function fallbackMock(): ChatApi {
  const ME: ChatFrom = { addr: "0x000000000000000000000000000000000000beef", name: "you", badge: "believer", prestige: 3 };
  const subs = new Set<(m: ChatMsg) => void>();
  let tokens = 5, last = Date.now(), loggedIn = false;
  return {
    async history(coin) { return Array.from({ length: 24 }, () => synthMsg(coin)); },
    subscribe(coin, onMsg, o) {
      subs.add(onMsg); o?.onState?.("connecting"); const t = setTimeout(() => o?.onState?.("live"), 300);
      let iv: ReturnType<typeof setTimeout>;
      const loop = () => { onMsg(synthMsg(coin)); iv = setTimeout(loop, 300 + Math.random() * 1200); }; iv = setTimeout(loop, 500);
      return () => { subs.delete(onMsg); clearTimeout(t); clearTimeout(iv); o?.onState?.("closed"); };
    },
    async send(coin, text) {
      if (Array.from(text).length > MAX_LEN) return { ok: false, error: "too_long" };
      if (!loggedIn) return { ok: false, error: "no_identity" };
      if (/\b(scam|fud)\b/i.test(text)) return { ok: false, error: "filtered" };
      const now = Date.now(); tokens = Math.min(5, tokens + (now - last) / 2000); last = now;
      if (tokens < 1) return { ok: false, error: "rate_limited", retryAfterMs: Math.ceil((1 - tokens) * 2000) };
      tokens -= 1;
      const msg: ChatMsg = { id: rid(), coin, kind: "user", from: ME, text: text.trim(), ts: now };
      subs.forEach((f) => f(msg)); return { ok: true, msg };
    },
    async login() { loggedIn = true; return { token: "mock", addr: ME.addr }; },
    logout() { loggedIn = false; },
    EMOTES: Object.fromEntries(EMOTE_CODES.map((c) => [c, ""])),
  };
}

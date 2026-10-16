/** Shared live-chat types + limits (client + server). */
export type ChatBadge = "believer" | "trencher" | "bomber" | "creator" | "whale" | "mod";
export type ChatFrom = { addr: string; name?: string; badge?: ChatBadge; prestige?: number };
export type ChatMsg = {
  id: string; // ulid, sortable
  coin: string; // lowercase token address
  kind: "user" | "event" | "system";
  from: ChatFrom | null;
  text: string; // filtered; emotes as :emote_code: tokens
  ts: number; // ms epoch, server time
  meta?: { event?: "buy" | "sell" | "nuke" | "graduate" | string; usd?: number; tx?: string; impactBps?: number; logIndex?: number; block?: number };
};
export type ChatState = "connecting" | "live" | "reconnecting" | "closed";
export type SendError = "rate_limited" | "filtered" | "too_long" | "no_identity";
export type SendResult = { ok: true; msg: ChatMsg } | { ok: false; error: SendError; retryAfterMs?: number };

export const CHAT_LIMITS = {
  maxLen: 200,
  keepPerCoin: 200,
  historyMax: 200,
  /** token bucket: burst 5, refill 1 token / 2s */
  burst: 5,
  refillMs: 2000,
  tokenTtlMs: 12 * 60 * 60 * 1000,
} as const;

export const EMOTE_CODES = ["halo", "rocket", "nuke", "diamond_hands", "wings", "candle", "gold_coin", "skull"] as const;
export const isCoin = (c: string) => /^0x[0-9a-f]{40}$/.test(c);

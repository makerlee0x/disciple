/** Pure token bucket (burst 5, +1 token per 2s). Store-agnostic: state in, state out. */
import { CHAT_LIMITS } from "./types";
export type Bucket = { tokens: number; at: number };
export function take(b: Bucket | null, now: number, burst: number = CHAT_LIMITS.burst, refillMs: number = CHAT_LIMITS.refillMs): { ok: boolean; bucket: Bucket; retryAfterMs: number } {
  const cur = b ? Math.min(burst, b.tokens + (now - b.at) / refillMs) : burst;
  if (cur >= 1) return { ok: true, bucket: { tokens: cur - 1, at: now }, retryAfterMs: 0 };
  return { ok: false, bucket: { tokens: cur, at: now }, retryAfterMs: Math.ceil((1 - cur) * refillMs) };
}

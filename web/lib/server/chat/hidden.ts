import "server-only";
/**
 * Chat messages the Team removed, or that 3 different players reported (App Review 1.2). One small KV string per coin
 * (`chat:hidden:<coin>`, a JSON array of message ids, newest last, ≤300), read at most once per HIDDEN_TTL_MS per coin on
 * each server instance, so the 400 ms stream poll adds no KV traffic. History and the live stream both drop these ids.
 */
import type { ChatMsg } from "@/lib/chat/types";
import { kv } from "@/lib/server/kv";

const HIDDEN_TTL_MS = 5_000, KEEP = 300;
const key = (coin: string) => `chat:hidden:${coin}`;
const cache = new Map<string, { t: number; p: Promise<Set<string>> }>();

export function parseHidden(v: string | null): string[] {
  try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

export function hiddenIds(coin: string, now = Date.now()): Promise<Set<string>> {
  const hit = cache.get(coin);
  if (hit && now - hit.t < HIDDEN_TTL_MS) return hit.p;
  const p = kv().get(key(coin)).then((v) => new Set(parseHidden(v))).catch(() => new Set<string>());
  cache.set(coin, { t: now, p });
  if (cache.size > 1000) for (const [k, v] of cache) if (now - v.t > 60_000) cache.delete(k);
  return p;
}

export async function dropHidden(coin: string, msgs: ChatMsg[]): Promise<ChatMsg[]> {
  if (!msgs.length) return msgs;
  const h = await hiddenIds(coin);
  return h.size ? msgs.filter((m) => !h.has(m.id)) : msgs;
}

/** hide (on=true) or restore one message. Takes effect everywhere within HIDDEN_TTL_MS. */
export async function setHidden(coin: string, id: string, on: boolean): Promise<void> {
  const ids = parseHidden(await kv().get(key(coin))).filter((x) => x !== id);
  if (on) ids.push(id);
  await kv().set(key(coin), JSON.stringify(ids.slice(-KEEP)));
  cache.delete(coin);
}

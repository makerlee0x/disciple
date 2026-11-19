import "server-only";
/**
 * Pilot names for the site search (lib/server/search): a sorted set of every claimed @username (member = username,
 * score = when it was claimed). lib/server/usernames keeps it in step on each claim / rename / reserved bind. Names
 * claimed before the index existed are filled in once with a SCAN over user:name:* (fillUserIndex).
 */
import type { Kv } from "./kv";

export const USERS_Z = "search:users";
const FILLED = "search:users:filled:v1";

/** Add `username` to the index and drop `prev` (the wallet's old name) if it changed. Never throws. */
export async function indexUsername(s: Kv, username: string, prev?: string | null): Promise<void> {
  try {
    if (prev && prev !== username) await s.zrem(USERS_Z, prev);
    await s.zadd(USERS_Z, [{ score: Date.now(), member: username }]);
  } catch (e) { console.warn("[search] index username failed", (e as Error).message); }
}

/** Drop a name that no longer points at a wallet (a reserved name moved away keeps its own entry). Never throws. */
export async function unindexUsername(s: Kv, username: string): Promise<void> {
  try { await s.zrem(USERS_Z, username); } catch { /* best effort */ }
}

/** One-time fill from the registry keys (no-op once done, or when the store can't SCAN). */
export async function fillUserIndex(s: Kv): Promise<number> {
  if (!s.scan) return 0;
  if (await s.get(FILLED)) return 0;
  if (!(await s.setNX(`${FILLED}:lock`, "1", 120))) return 0;
  const keys = await s.scan("user:name:*");
  const names = keys.map((k) => k.slice("user:name:".length)).filter((n) => /^[a-z0-9_]+$/.test(n));
  const now = Date.now();
  if (names.length) await s.zadd(USERS_Z, names.map((member) => ({ score: now, member })));
  await s.set(FILLED, String(now));
  return names.length;
}

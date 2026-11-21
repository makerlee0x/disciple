import "server-only";
/**
 * Flight streak days (lib/streaks): the UTC days a pilot finished a match. Kept apart from lib/server/streaks so the duel
 * store and the Free play route can record a play without loading the trade readers.
 */
import { dayIndex, PLAY_MODES, type PlayMode } from "@/lib/streaks";
import { kv, type Kv } from "./kv";
import { XPK } from "./xp";

/** zset score=day index, member=day index */
export const playsKey = (w: string) => `${XPK.checkins(w)}:play`;
const isPlayMode = (m: unknown): m is PlayMode => typeof m === "string" && (PLAY_MODES as readonly string[]).includes(m);

/** today's play (idempotent: a member per day). Server-verified runs call it directly; Turbo matches send a ping. */
export async function recordPlay(wallet: string, mode: unknown, now = Date.now(), s: Kv = kv()): Promise<boolean> {
  if (!isPlayMode(mode) || !/^0x[0-9a-f]{40}$/i.test(wallet)) return false;
  const d = dayIndex(now);
  await s.zadd(playsKey(wallet.toLowerCase()), [{ score: d, member: String(d) }]);
  return true;
}

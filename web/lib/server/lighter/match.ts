import "server-only";
/**
 * The buzzer on Lighter (maker 2026-11-18: "the position should be closed at the buzzer, for duel and royale and climb").
 * A match arms itself for a pilot (id, markets, when it ends); at the buzzer the server closes that pilot's open
 * positions on those markets with its own key, so a closed tab or a dropped connection never leaves a real position open.
 *
 *   Duel: the duel store calls buzzer() for both seats when the room settles (overtime included).
 *   Climb / Royale (they run in the browser): arming starts a server timer for the match length; it fires buzzer().
 * A newer match replaces the armed one, so an old timer never closes a new match's trade.
 * Backup: every arm is also listed in a sorted set by end time; a 1-minute cron (GET /api/lighter/buzz, fra1) fires the
 * buzzer for any match past its end, so a lost timer or an unsettled duel still closes (sweepArmed).
 * The buzzer closes fully: flattenMarket reads Lighter until nothing is open.
 */
import { kv, type Kv } from "@/lib/server/kv";
import { lighterConfig, LIGHTER_MARKETS, type LighterMarket } from "./config";
import { flattenMarket } from "./player";
import { getPlayer } from "./keys";
import { LighterError } from "./rest";

export type MatchKind = "duel" | "climb" | "royale";
type Armed = { kind: MatchKind; id: string; markets: LighterMarket[]; endAt: number };
const key = (net: string, pid: string) => `lighter:match:${net}:${pid}`;

export async function armMatch(pid: string, kind: MatchKind, id: string, markets: LighterMarket[], endAt: number, s: Kv = kv()) {
  const cfg = lighterConfig();
  if (!cfg.enabled) return null;
  const k = key(cfg.network, pid);
  const prev = await s.get(k).then((v) => (v ? (JSON.parse(v) as Armed) : null)).catch(() => null);
  // the same match arming again (Royale moving to a new coin) adds its market
  const again = !!prev && prev.id === id;
  const ms = again ? [...new Set([...prev!.markets, ...markets])] : markets;
  const a: Armed = { kind, id, markets: ms, endAt: again ? prev!.endAt : endAt };
  const v = JSON.stringify(a);
  await s.set(k, v);
  await s.expireIfEq(k, v, Math.max(60, Math.ceil((a.endAt - Date.now()) / 1000) + 600));
  await s.zadd(armedKey(cfg.network), [{ score: a.endAt, member: armedMember(a.endAt, pid, id) }]).catch((e) => console.error("[lighter] arm list", e));
  return { ...a, fresh: !again };
}

/** Did this pilot arm match `id` on Lighter (a real-money match)? Read before the buzzer disarms it. */
export async function armedFor(pid: string, id: string, s: Kv = kv()): Promise<boolean> {
  const cfg = lighterConfig();
  if (!cfg.enabled) return false;
  const raw = await s.get(key(cfg.network, pid)).catch(() => null);
  try { return !!raw && (JSON.parse(raw) as Armed).id === id; } catch { return false; }
}

/** Closes what the armed match `id` left open on Lighter, then disarms. Quiet when nothing is armed or open. */
export async function buzzer(pid: string, id: string, s: Kv = kv()): Promise<boolean> {
  const cfg = lighterConfig();
  if (!cfg.enabled) return true;
  const k = key(cfg.network, pid);
  const raw = await s.get(k).catch(() => null);
  const a = raw ? (JSON.parse(raw) as Armed) : null;
  if (!a || a.id !== id) return true;
  if (!(await getPlayer(cfg, pid))?.keyReady) { await s.delIfEq(k, raw!); return true; }
  let flat = true;
  for (const m of a.markets) {
    if (!(m in LIGHTER_MARKETS)) continue;
    try { flat = (await flattenMarket(cfg, pid, m)).flat && flat; }
    catch (e) { flat = false; if (!(e instanceof LighterError && e.status === 409)) console.error("[lighter] buzzer close", m, e); }
  }
  // still open (Lighter down, a refused close): keep it armed so the next sweep tries again
  if (flat) await s.delIfEq(k, raw!);
  else await s.expireIfEq(k, raw!, 30 * 60).catch(() => false);
  return flat;
}

const armedKey = (net: string) => `lighter:armed:${net}`;
const armedMember = (endAt: number, pid: string, id: string) => `${endAt}|${pid}|${id}`;
/** Grace after a match's end before the sweep steps in (the duel's own settle and the after() timer go first). */
export const SWEEP_GRACE_MS = 15_000;
/**
 * The cron's backup buzzer: fires buzzer() for every armed match whose end (plus SWEEP_GRACE_MS) has passed, then drops
 * it from the list once it's closed or disarmed. A match still open after a buzzer stays listed for the next run, for
 * up to SWEEP_GIVE_UP_MS. Returns what it did.
 */
export const SWEEP_GIVE_UP_MS = 30 * 60_000;
export async function sweepArmed(now = Date.now(), s: Kv = kv(), fire: (pid: string, id: string) => Promise<boolean | void> = (p, i) => buzzer(p, i, s)) {
  const cfg = lighterConfig();
  if (!cfg.enabled) return { checked: 0, closed: 0, kept: 0 };
  const k = armedKey(cfg.network);
  const list = await s.zrange(k, 50);
  let checked = 0, closed = 0, kept = 0;
  for (const mem of list) {
    const [endS, pid, id] = mem.split("|");
    const endAt = Number(endS);
    if (!(endAt + SWEEP_GRACE_MS <= now)) break; // sorted by end time: the rest aren't due
    checked++;
    let ok: boolean | void = false;
    try { ok = await fire(pid, id); } catch (e) { console.error("[lighter] sweep", e); }
    if (ok !== false || now - endAt > SWEEP_GIVE_UP_MS) { await s.zrem(k, mem); closed++; }
    else kept++;
  }
  if (kept) console.error("[lighter] sweep: positions still open after the buzzer", kept);
  return { checked, closed, kept };
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

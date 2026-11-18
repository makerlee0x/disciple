import "server-only";
/**
 * The buzzer on Lighter (maker 2026-11-18: "the position should be closed at the buzzer, for duel and royale and climb").
 * A match arms itself for a pilot (id, markets, when it ends); at the buzzer the server closes that pilot's open
 * positions on those markets with its own key, so a closed tab or a dropped connection never leaves a real position open.
 *
 *   Duel: the duel store calls buzzer() for both seats when the room settles (overtime included).
 *   Climb / Royale (they run in the browser): arming starts a server timer for the match length; it fires buzzer().
 * A newer match replaces the armed one, so an old timer never closes a new match's trade.
 */
import { kv, type Kv } from "@/lib/server/kv";
import { lighterConfig, LIGHTER_MARKETS, type LighterMarket } from "./config";
import { closeMarket } from "./player";
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
  return { ...a, fresh: !again };
}

/** Closes what the armed match `id` left open on Lighter, then disarms. Quiet when nothing is armed or open. */
export async function buzzer(pid: string, id: string, s: Kv = kv()) {
  const cfg = lighterConfig();
  if (!cfg.enabled) return;
  const k = key(cfg.network, pid);
  const raw = await s.get(k).catch(() => null);
  const a = raw ? (JSON.parse(raw) as Armed) : null;
  if (!a || a.id !== id) return;
  if (!(await getPlayer(cfg, pid))?.keyReady) { await s.delIfEq(k, raw!); return; }
  for (const m of a.markets) {
    if (!(m in LIGHTER_MARKETS)) continue;
    try { await closeMarket(cfg, pid, m); }
    catch (e) { if (!(e instanceof LighterError && e.status === 409)) console.error("[lighter] buzzer close", m, e); } // 409 = nothing open
  }
  await s.delIfEq(k, raw!);
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

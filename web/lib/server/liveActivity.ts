import "server-only";
/**
 * Live Activities while the app is closed (maker 2026-11-14 option 5). The app registers each running flight activity
 * (POST /api/live-activity: its ActivityKit push token, the coin, what went in and the bag's share of the supply); the cron
 * (GET /api/cron/live-activity, every minute) reads each coin's market cap and pushes the new numbers (lib/liveFlight).
 * An activity is dropped when the app ends it (DELETE), Apple says the token is gone, or after MAX_AGE (Apple stops
 * showing an activity after 8 hours anyway). Off until the APNS_* keys are set (lib/server/apns).
 */
import { liveFlightNumbers } from "@/lib/liveFlight";
import { apnsKeys, sendLiveActivity, validApnsToken, type ApnsEnv } from "./apns";
import { getHomeData } from "./home";
import { kv, type Kv } from "./kv";

export type LiveRec = { token: string; env: ApnsEnv; wallet: string | null; coin: string; ticker: string; investedUsd: number; share: number; at: number; lastMcap?: number };
const K = { active: "la:active", rec: (t: string) => `la:rec:${t}` };
export const LIVE_MAX_AGE_MS = 8 * 3_600_000;
const parse = (s: string | null): LiveRec | null => { try { return s ? (JSON.parse(s) as LiveRec) : null; } catch { return null; } };

export async function registerLive(r: LiveRec, s: Kv = kv()): Promise<void> {
  if (!validApnsToken(r.token)) return;
  await s.set(K.rec(r.token), JSON.stringify(r));
  await s.zadd(K.active, [{ score: r.at, member: r.token }]);
}
export async function dropLive(token: string, s: Kv = kv()): Promise<void> { await s.zrem(K.active, token); await s.del(K.rec(token)); }

export type LiveRun = { checked: number; sent: number; dropped: number };
export async function runLiveActivities(budgetMs = 45_000, now = Date.now(), s: Kv = kv()): Promise<LiveRun> {
  const keys = apnsKeys(); const out: LiveRun = { checked: 0, sent: 0, dropped: 0 };
  if (!keys) return out;
  const tokens = await s.zrange(K.active, 500);
  if (!tokens.length) return out;
  const mcapOf = new Map((await getHomeData()).coins.map((c) => [c.token.toLowerCase(), Number(c.mcapUsd) || 0]));
  const t0 = Date.now();
  for (const token of tokens) {
    if (Date.now() - t0 > budgetMs) break;
    out.checked++;
    const r = parse(await s.get(K.rec(token)));
    if (!r || now - r.at > LIVE_MAX_AGE_MS) { await dropLive(token, s); out.dropped++; continue; }
    const mcap = mcapOf.get(r.coin) ?? 0;
    if (!(mcap > 0) || mcap === r.lastMcap) continue;   // nothing new to say: Apple rations activity pushes
    const st = liveFlightNumbers({ mcap, share: r.share, investedUsd: r.investedUsd });
    const res = await sendLiveActivity(token, r.env, { event: "update", state: st, staleSec: 15 * 60 }, keys);
    if (res === "gone") { await dropLive(token, s); out.dropped++; continue; }
    if (res === "ok") { out.sent++; await s.set(K.rec(token), JSON.stringify({ ...r, lastMcap: mcap })); }
  }
  return out;
}

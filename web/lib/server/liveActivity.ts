import "server-only";
/**
 * The flight on the iPhone lock screen / Dynamic Island while the app is closed (maker 2026-11-14). The app starts the Live
 * Activity itself (components/flight/LiveFlight) and registers its push token here; /api/cron/live-activity then sends an
 * update about once a minute from the indexed fills and the coin's current mcap, and ends it once the bag is sold or after
 * MAX_AGE_MS. KV:
 *   la:t:<token>  JSON LiveReg          la:all  zset of tokens (score = registered at)          la:w:<wallet>  the wallet's current token (one at a time)
 */
import { kv, type Kv } from "./kv";
import { apnsKeys, liveActivityPayload, sendApns, validApnsToken, type ApnsEnv } from "./apns";
import { liveState } from "@/lib/liveFlight";
import type { PositionPnl } from "@/lib/sharePnl";

export type LiveReg = { wallet: string; coin: string; ticker: string; env: ApnsEnv; at: number; last: number };
export const MAX_AGE_MS = 8 * 3600_000;
const K = { t: (t: string) => `la:t:${t}`, all: () => "la:all", w: (w: string) => `la:w:${w.toLowerCase()}` };
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function registerLive(walletIn: string, o: { token: unknown; env?: unknown; coin: unknown; ticker?: unknown }, now = Date.now(), s: Kv = kv()): Promise<boolean> {
  if (!validApnsToken(o.token) || !isAddr(o.coin)) return false;
  const w = walletIn.toLowerCase();
  const prev = await s.get(K.w(w));
  if (prev && prev !== o.token) { await s.del(K.t(prev)); await s.zrem(K.all(), prev); }
  const ticker = typeof o.ticker === "string" ? o.ticker.replace(/[^A-Za-z0-9$]/g, "").slice(0, 12) : "";
  const reg: LiveReg = { wallet: w, coin: o.coin.toLowerCase(), ticker, env: o.env === "sandbox" ? "sandbox" : "production", at: now, last: 0 };
  await s.set(K.t(o.token), JSON.stringify(reg));
  await s.zadd(K.all(), [{ score: now, member: o.token }]);
  await s.set(K.w(w), o.token);
  return true;
}

export async function dropLive(token: string, s: Kv = kv()) {
  const r = await s.get(K.t(token));
  await s.del(K.t(token)); await s.zrem(K.all(), token);
  if (r) { try { const w = (JSON.parse(r) as LiveReg).wallet; if ((await s.get(K.w(w))) === token) await s.del(K.w(w)); } catch { /* bad row */ } }
}

/** One cron pass: update every registered activity, end the finished ones. */
export async function runLiveActivities(pnlOf: (wallet: string, coin: string) => Promise<PositionPnl>, budgetMs = 40_000, now = Date.now(), s: Kv = kv()) {
  const keys = apnsKeys();
  if (!keys) return { skipped: "apns_not_configured" };
  const t0 = Date.now(), tokens = await s.zrange(K.all(), 2000);
  let sent = 0, ended = 0, dropped = 0;
  for (const token of tokens) {
    if (Date.now() - t0 > budgetMs) break;
    const raw = await s.get(K.t(token));
    if (!raw) { await s.zrem(K.all(), token); continue; }
    let reg: LiveReg;
    try { reg = JSON.parse(raw) as LiveReg; } catch { await dropLive(token, s); continue; }
    const p = await pnlOf(reg.wallet, reg.coin).catch(() => null);
    if (!p) continue;
    // the first buy may not be indexed yet: give a fresh activity a few minutes before "no position" counts as done
    if (p.kind === "none" && now - reg.at < 10 * 60_000) continue;
    const st = liveState(p), end = st.closed || now - reg.at > MAX_AGE_MS;
    const r = await sendApns(token, reg.env, { live: liveActivityPayload(st, end ? "end" : "update", now) }, keys);
    if (r === "gone" || end) { await dropLive(token, s); if (r === "gone") dropped++; else ended++; continue; }
    if (r === "ok") { sent++; await s.set(K.t(token), JSON.stringify({ ...reg, last: now })); }
  }
  return { tokens: tokens.length, sent, ended, dropped };
}

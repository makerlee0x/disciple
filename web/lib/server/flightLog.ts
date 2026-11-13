import "server-only";
/** Loads a flight log (lib/flightLog.ts) from the indexed trades, the drafting claims and the XP ledger. */
import { computeFlightLog, type FlightLog } from "@/lib/flightLog";
import { playerUsd } from "@/lib/trades";
import type { DraftClaim } from "@/lib/xp";
import { kv, type Kv } from "./kv";
import { tradesOf } from "./trades";
import { ledgerOf, XPK } from "./xp";

/** a flight is at most this long (an open tab left overnight still logs one day) */
export const FLIGHT_LOG_MAX_MS = 24 * 3600_000;

export async function flightLogFor(walletIn: string, coinIn: string, sinceIn: number, now = Date.now(), s: Kv = kv(), maxMs = FLIGHT_LOG_MAX_MS): Promise<FlightLog> {
  const w = walletIn.toLowerCase(), coin = coinIn.toLowerCase();
  const since = Math.max(now - maxMs, Math.min(now, sinceIn));
  // the wallet's whole history on this coin (to know when it was aboard) + the coin's recent trades (the flight itself)
  const [mine, recent, claims, rows] = await Promise.all([
    tradesOf(coin, w, 5000, "asc"),
    tradesOf(coin, null, 2000, "desc"),
    s.zrange(XPK.drafts(w), 200, true),
    ledgerOf(w, s),
  ]);
  const seen = new Set<string>(), fills = [];
  for (const f of [...mine, ...recent]) {
    if (seen.has(f.id)) continue; seen.add(f.id);
    fills.push({ ts: f.ts, block: f.block, logIndex: f.logIndex, trader: f.trader, side: f.side, tokens: f.tokens, usd: playerUsd(f), mcapUsd: f.mcapUsd, impactBps: typeof f.impactBps === "number" ? Math.abs(f.impactBps) : undefined });
  }
  let slingshots = 0;
  for (const m of claims) { try { const c = JSON.parse(m) as DraftClaim; if (c.coin?.toLowerCase() === coin && c.at >= since && c.at <= now) slingshots++; } catch { /* skip */ } }
  const xp = rows.filter((r) => r.ts >= since && r.ts <= now && r.xp > 0).reduce((t, r) => t + r.xp, 0);
  return computeFlightLog({ wallet: w, since, now, fills, slingshots, xp });
}

/** a share card covers the whole position (first fill → now / last fill), up to a month back */
export const SHARE_LOG_MAX_MS = 30 * 86_400_000;

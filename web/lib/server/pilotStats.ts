import "server-only";
/**
 * One pilot's stats page (/achievements, /u/<name>/stats; maker 2026-11-19): ranks in every mode plus the career numbers,
 * gathered from the stores the boards already use. Public (PnL and ranks are public). Cached per wallet for CACHE_MS so a
 * shared page doesn't hammer KV. Any part that fails reads as null (the page shows "—"), never as a made-up 0.
 */
import { dailyIdAt } from "@/lib/sim/daily";
import { positionBoard } from "@/lib/home/topPilots";
import { profileStatsFrom } from "@/lib/profileStatsCore";
import type { Fill } from "@/lib/trades";
import { getHomeData } from "./home";
import { getLeaderboard, getOverall, lifetimeOf } from "./leaderboard";
import { climbBoard } from "./seasonModes";
import { duelBoard } from "./duel/store";
import { pkey, placeOf, readRun } from "./daily";
import { coinsOf, tradesOf, TRADES_MAX_LIMIT } from "./trades";
import { serverProfileStats } from "./profileStats";
import { kv } from "./kv";
import { equippedOf } from "./collection";

const CACHE_MS = 60_000;
const DAILY_DAYS = 30;
const MAX_COINS = 40;

type Coin = { ticker: string; icon: string };
export type PilotStats = {
  /** equipped hull skin id (lib/collection skinArt), "" = stock */
  skin: string;
  season: { n: number; rank: number | null; total: number; pts: number; league: string } | null;
  lifetime: { pts: number; rank: number } | null;
  pnlUsd: number | null;
  duel: { rank: number | null; w: number; l: number; streak: number } | null;
  climb: { rank: number | null; level: number; clearMs: number } | null;
  daily: { best: number | null; played: number; today: number | null } | null;
  rockets: { rank: number | null; green: number; red: number; orbits: number; longestMs: number } | null;
  career: { winRate: number | null; trades: number; bombs: number; bestRocket: (Coin & { pnlUsd: number }) | null; bestTrade: (Coin & { pct: number; pnlUsd: number }) | null } | null;
};

const g = globalThis as unknown as { __dscPilotStats?: Map<string, { at: number; v: PilotStats }> };
const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch((e) => { console.warn("[disciple] pilot stats part failed", (e as Error).message); return null; });

async function season(w: string): Promise<PilotStats["season"]> {
  const o = await getOverall(w);
  return { n: o.season.n, rank: o.me?.rank ?? null, total: o.total, pts: o.me?.pts ?? 0, league: o.me?.league ?? "rookie" };
}

async function duel(w: string): Promise<PilotStats["duel"]> {
  const d = await duelBoard(1, w);
  return d.me ? { rank: d.me.rank, w: d.me.w, l: d.me.l, streak: d.me.streak } : null;
}

async function climb(w: string): Promise<PilotStats["climb"]> {
  const rows = await climbBoard(1000);
  const i = rows.findIndex((r) => r.wallet === w);
  return i < 0 ? null : { rank: i + 1, level: rows[i].climbLevel, clearMs: rows[i].clearMs };
}

/** Daily mission: best finish over the last DAILY_DAYS days (runs this wallet put on a board) and today's place. */
async function daily(w: string): Promise<PilotStats["daily"]> {
  const s = kv(), today = dailyIdAt(Date.now());
  const ids = Array.from({ length: DAILY_DAYS }, (_, i) => today - i).filter((id) => id > 0);
  const runIds = await s.mget(ids.map((id) => pkey(id, w)));
  const played = ids.flatMap((id, i) => (runIds[i] ? [{ id, runId: runIds[i]! }] : []));
  if (!played.length) return null;
  const places = await Promise.all(played.map(async ({ id, runId }) => {
    const r = await readRun(id, runId, s);
    return r ? { id, rank: (await placeOf(id, r, s)).rank } : null;
  }));
  const ok = places.filter((p): p is { id: number; rank: number } => !!p);
  return { best: ok.length ? Math.min(...ok.map((p) => p.rank)) : null, played: played.length, today: ok.find((p) => p.id === today)?.rank ?? null };
}

async function rockets(w: string): Promise<{ rockets: PilotStats["rockets"]; pnlUsd: number | null }> {
  const b = await getLeaderboard("all", "pnl", w);
  const m = b.me;
  return { rockets: m ? { rank: m.rank, green: m.green, red: m.red, orbits: m.orbits, longestMs: m.aboardMs } : null, pnlUsd: m ? m.pnlUsd : null };
}

/** Win rate, trades and bombs (the profile summary) plus the best rocket (most realized $) and best trade (biggest $ trip). */
async function career(w: string): Promise<PilotStats["career"]> {
  const [p, home] = await Promise.all([serverProfileStats(w), getHomeData().catch(() => null)]);
  const icon = (token: string) => home?.coins.find((c) => c.token.toLowerCase() === token.toLowerCase())?.icon ?? "";
  const tick = (token: string) => p.trades.find((t) => t.token.toLowerCase() === token.toLowerCase())?.ticker ?? "";
  const rocketsBy = profileStatsFrom(p.trades, "").rockets.filter((r) => r.pnl > 0);
  const top = rocketsBy[0];
  const coins = (await coinsOf(w)).slice(0, MAX_COINS);
  const fills: Fill[][] = await Promise.all(coins.map((c) => tradesOf(c, w, TRADES_MAX_LIMIT, "asc")));
  const best = positionBoard(fills, Date.now(), {}, 1).all[0];
  const t = (x: string) => { const k = tick(x); return k ? `$${k}` : "Rocket"; };
  return {
    winRate: p.summary.closedTrades ? p.summary.winRate : null, trades: p.summary.trades, bombs: p.summary.bombsDropped,
    bestRocket: top ? { ticker: t(top.token), icon: icon(top.token), pnlUsd: Math.round(top.pnl * 100) / 100 } : null,
    bestTrade: best ? { ticker: t(best.coin), icon: icon(best.coin), pct: best.pct, pnlUsd: best.pnlUsd } : null,
  };
}

export async function pilotStats(wallet: string): Promise<PilotStats> {
  const w = wallet.toLowerCase();
  const cache = (g.__dscPilotStats ??= new Map());
  const hit = cache.get(w);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const [se, life, du, cl, da, ro, ca, eq] = await Promise.all([
    safe(season(w)), safe(lifetimeOf(w)), safe(duel(w)), safe(climb(w)), safe(daily(w)), safe(rockets(w)), safe(career(w)), safe(equippedOf(w)),
  ]);
  const v: PilotStats = {
    skin: eq?.skin ?? "", season: se, lifetime: life ? { pts: life.pts, rank: life.rank } : null, pnlUsd: ro?.pnlUsd ?? null,
    duel: du, climb: cl, daily: da, rockets: ro?.rockets ?? null, career: ca,
  };
  if (cache.size > 2000) cache.clear();
  cache.set(w, { at: Date.now(), v });
  return v;
}

/**
 * Team stats (/admin/stats): pure roll-ups over data the site already keeps. No new tracking, no new store:
 *  - sign-ups: Privy users (created_at, linked login types), read server side with the app secret
 *  - launches: Launchpad `Launched` events (creator, block time)
 *  - trading: the KV trade index fills (trader, usd, ts)
 * Days are UTC calendar days, the same buckets as the funnel counters (lib/funnel.ts).
 * Pure (no server-only, no DOM): used by lib/server/adminStats.ts and scripts/test-admin-stats.mts.
 */
import { lastDays, utcDay } from "./funnel";

export type StatUser = { id: string; createdMs: number; logins: string[]; guest?: boolean };
export type StatLaunch = { token: string; name: string; ticker: string; creator: string; ts: number; mcapUsd: number; graduated: boolean; anon?: boolean };
export type StatFill = { coin: string; trader: string; usd: number; ts: number; side: "buy" | "sell"; usdIn?: number; usdOut?: number };

export type Window = { today: number; d7: number; d30: number; total: number };
export type DayRow = { day: string } & Record<string, number | string>;

const DAY = 86400_000;
/** Real USDG of a fill when the router reported it, else the quote value. */
export const fillVolume = (f: StatFill) => (f.side === "buy" ? f.usdIn : f.usdOut) ?? f.usd ?? 0;

/** today = the current UTC day; d7 / d30 = the last 7 / 30 UTC days including today. */
export function windowOf(times: number[], now: number): Window {
  const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
  const d7 = today - 6 * DAY, d30 = today - 29 * DAY;
  let t = 0, a = 0, b = 0;
  for (const x of times) { if (x >= today) t++; if (x >= d7) a++; if (x >= d30) b++; }
  return { today: t, d7: a, d30: b, total: times.length };
}

export function userStats(users: StatUser[], now: number, days = 14) {
  const real = users.filter((u) => !u.guest);
  const logins: Record<string, number> = {};
  for (const u of real) for (const l of new Set(u.logins.map(loginLabel))) logins[l] = (logins[l] ?? 0) + 1;
  const byDay = lastDays(now, days).map((day) => ({ day, signups: real.filter((u) => utcDay(u.createdMs) === day).length }));
  return { ...windowOf(real.map((u) => u.createdMs), now), logins, byDay };
}

/** Privy linked-account type → short label. Wallet logins are anything wallet-shaped. */
export function loginLabel(t: string): string {
  if (t === "email") return "Email";
  if (t === "google_oauth") return "Google";
  if (t === "apple_oauth") return "Apple";
  if (t === "twitter_oauth") return "X";
  if (t === "wallet" || t === "smart_wallet" || t === "cross_app") return "Wallet";
  return "Other";
}

export function launchStats(launches: StatLaunch[], now: number, days = 14, top = 10) {
  const by = new Map<string, number>();
  for (const l of launches) if (!l.anon) by.set(l.creator.toLowerCase(), (by.get(l.creator.toLowerCase()) ?? 0) + 1);
  const launchers = [...by.entries()].map(([wallet, n]) => ({ wallet, launches: n })).sort((a, b) => b.launches - a.launches).slice(0, top);
  const byDay = lastDays(now, days).map((day) => ({ day, launches: launches.filter((l) => utcDay(l.ts) === day).length }));
  return {
    ...windowOf(launches.map((l) => l.ts), now),
    anon: launches.filter((l) => l.anon).length,
    graduated: launches.filter((l) => l.graduated).length,
    launchers: by.size,
    byDay, top: launchers,
    recent: [...launches].sort((a, b) => b.ts - a.ts).slice(0, 10),
  };
}

type Agg = { trades: number; volume: number; traders: Set<string> };
const agg = (): Agg => ({ trades: 0, volume: 0, traders: new Set() });
const add = (a: Agg, f: StatFill) => { a.trades++; a.volume += fillVolume(f); a.traders.add(f.trader.toLowerCase()); };
const out = (a: Agg) => ({ trades: a.trades, volume: Math.round(a.volume * 100) / 100, traders: a.traders.size });

export function tradeStats(fills: StatFill[], now: number, days = 14, top = 10) {
  const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
  const w = { today: agg(), d7: agg(), d30: agg(), total: agg() };
  const dayList = lastDays(now, days);
  const perDay = new Map(dayList.map((d) => [d, agg()]));
  const traders = new Map<string, { volume: number; trades: number; coins: Set<string> }>();
  const coins = new Map<string, { volume: number; trades: number }>();
  const firstSeen = new Map<string, number>();
  for (const f of fills) {
    const v = fillVolume(f), t = f.trader.toLowerCase();
    add(w.total, f);
    if (f.ts >= today) add(w.today, f);
    if (f.ts >= today - 6 * DAY) add(w.d7, f);
    if (f.ts >= today - 29 * DAY) add(w.d30, f);
    const d = perDay.get(utcDay(f.ts)); if (d) add(d, f);
    const r = traders.get(t) ?? { volume: 0, trades: 0, coins: new Set<string>() };
    r.volume += v; r.trades++; r.coins.add(f.coin.toLowerCase()); traders.set(t, r);
    const c = coins.get(f.coin.toLowerCase()) ?? { volume: 0, trades: 0 };
    c.volume += v; c.trades++; coins.set(f.coin.toLowerCase(), c);
    firstSeen.set(t, Math.min(firstSeen.get(t) ?? Infinity, f.ts));
  }
  const firsts = [...firstSeen.values()];
  return {
    today: out(w.today), d7: out(w.d7), d30: out(w.d30), total: out(w.total),
    /** wallets whose first trade on this stack landed in the window */
    newTraders: windowOf(firsts, now),
    byDay: dayList.map((day) => ({ day, ...out(perDay.get(day)!), newTraders: firsts.filter((x) => utcDay(x) === day).length })),
    top: [...traders.entries()].map(([wallet, r]) => ({ wallet, volume: Math.round(r.volume * 100) / 100, trades: r.trades, coins: r.coins.size }))
      .sort((a, b) => b.volume - a.volume).slice(0, top),
    topCoins: [...coins.entries()].map(([coin, r]) => ({ coin, volume: Math.round(r.volume * 100) / 100, trades: r.trades }))
      .sort((a, b) => b.volume - a.volume).slice(0, top),
  };
}

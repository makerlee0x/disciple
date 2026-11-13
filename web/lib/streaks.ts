/**
 * Steady-hand streaks (main mode hook loop, maker 2026-11-13, mockup board "Steady-hand streaks"). Pure.
 *
 * Two streaks, each with one free paused day ("shield") per UTC week (Monday start):
 *  - Aboard: one rocket held at $5+ of cost through a whole UTC day. Cost, not price, so a falling rocket never breaks
 *    it and a trade never keeps it alive (a buy during the day doesn't count until the day after).
 *  - Check-in: the logbook or crew opened once that UTC day. No trade needed.
 * XP: 20 a day per streak (40 a day at most), +100 at each 7-day mark. A missed day with no shield ends the streak
 * quietly: no warning, no "trade to save it" nudge.
 */
export const DAY = 86_400_000;
/** paid from the same day as the flight missions (nothing back-paid from before it) */
export const STREAKS_FROM = Date.UTC(2026, 10, 16);
export const STREAK_RULES = { minHoldUsd: 5, xpPerDay: 20, markEvery: 7, markXp: 100, windowDays: 60 } as const;

export const dayIndex = (ts: number) => Math.floor(ts / DAY);
/** UTC week id (Monday start): 1970-01-01 was a Thursday, so shift by 3 days */
export const weekIndex = (day: number) => Math.floor((day + 3) / 7);

export type DayState = "done" | "paused" | "missed" | "today" | "open";
export interface StreakDay { day: number; state: DayState }
export interface Streak {
  current: number; best: number;
  /** the last 7 days, oldest first, ending today */
  week: StreakDay[];
  /** the shield of this UTC week is spent */
  shieldUsed: boolean;
  /** the day the latest shield paused, if it's in the last 7 */
  pausedDay: number | null;
  /** today already counts (check-in) or is on its way (aboard: held since 00:00 UTC) */
  todayOk: boolean;
  /** days of the current streak with their 1-based position in it (for paying XP) */
  run: { day: number; n: number }[];
}

export interface StreakFill { ts: number; block?: number; logIndex?: number; side: "buy" | "sell"; tokens: number; usd: number }

/** Intervals [from, to) where one rocket's remaining cost stayed at $5+ (to = Infinity while it still does). */
export function heldIntervals(fills: readonly StreakFill[], minUsd: number = STREAK_RULES.minHoldUsd): [number, number][] {
  const fs = [...fills].sort((a, b) => a.ts - b.ts || (a.block ?? 0) - (b.block ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  const out: [number, number][] = [];
  let tokens = 0, cost = 0, from: number | null = null;
  for (const f of fs) {
    if (f.side === "buy") { tokens += f.tokens; cost += Math.max(0, f.usd); }
    else if (tokens > 0) { const k = Math.min(1, f.tokens / tokens); cost -= cost * k; tokens -= Math.min(tokens, f.tokens); if (tokens <= 1e-9) { tokens = 0; cost = 0; } }
    const ok = cost >= minUsd;
    if (ok && from === null) from = f.ts;
    else if (!ok && from !== null) { out.push([from, f.ts]); from = null; }
  }
  if (from !== null) out.push([from, Infinity]);
  return out;
}

/** UTC days (as day indexes) fully covered by one rocket's $5+ hold, plus whether today is covered so far. */
export function aboardDays(perCoin: readonly (readonly StreakFill[])[], now: number): { days: Set<number>; today: boolean } {
  const days = new Set<number>(), t = dayIndex(now);
  let today = false;
  for (const fills of perCoin) {
    for (const [a, b] of heldIntervals(fills)) {
      // a day counts when the hold started at or before its 00:00 and lasted to its end
      const first = Math.ceil(a / DAY), last = Math.min(t, Math.floor(Math.min(b, now) / DAY));
      for (let d = Math.max(first, t - STREAK_RULES.windowDays); d < last; d++) days.add(d);
      if (a <= t * DAY && b > now) today = true;
    }
  }
  return { days, today };
}

/**
 * Walk the window day by day. `done` holds the days that count. Today never breaks a streak: it's added when done
 * (check-in) and otherwise shown as open. A missed day spends the week's shield if the streak is alive, else resets it.
 */
export function streakOf(done: ReadonlySet<number>, now: number, o: { todayCounts: boolean; todayOk: boolean; since?: number }): Streak {
  const t = dayIndex(now), start = Math.max(t - STREAK_RULES.windowDays, o.since === undefined ? -Infinity : dayIndex(o.since));
  const shields = new Set<number>();
  const states = new Map<number, DayState>();
  let cur = 0, best = 0, run: { day: number; n: number }[] = [], pausedDay: number | null = null;
  for (let d = start; d <= t; d++) {
    if (d === t && !(o.todayCounts && done.has(d))) { states.set(d, o.todayOk ? "today" : "open"); break; }
    if (done.has(d)) { cur++; run.push({ day: d, n: cur }); states.set(d, "done"); }
    else if (cur > 0 && !shields.has(weekIndex(d))) { shields.add(weekIndex(d)); states.set(d, "paused"); pausedDay = d; }
    else { cur = 0; run = []; states.set(d, "missed"); }
    best = Math.max(best, cur);
  }
  const week: StreakDay[] = [];
  for (let d = t - 6; d <= t; d++) week.push({ day: d, state: states.get(d) ?? "missed" });
  return { current: cur, best, week, shieldUsed: shields.has(weekIndex(t)), pausedDay: pausedDay !== null && pausedDay > t - 7 ? pausedDay : null, todayOk: o.todayOk, run };
}

export type StreakKey = "aboard" | "checkin";
export interface StreakPay { src: string; xp: number; label: string; ts: number }

/** The ledger rows a streak has earned (once each by src; nothing before STREAKS_FROM). */
export function streakPays(key: StreakKey, s: Streak): StreakPay[] {
  const out: StreakPay[] = [], from = dayIndex(STREAKS_FROM);
  const name = key === "aboard" ? "Aboard streak" : "Check-in streak";
  for (const { day, n } of s.run) {
    if (day < from) continue;
    const ts = day * DAY + (key === "aboard" ? DAY - 1 : 0);
    out.push({ src: `streak:${key}:${day}`, xp: STREAK_RULES.xpPerDay, label: `${name} day ${n}`, ts });
    if (n % STREAK_RULES.markEvery === 0) out.push({ src: `streak:${key}:mark:${day}`, xp: STREAK_RULES.markXp, label: `${name}: ${n} days`, ts });
  }
  return out;
}

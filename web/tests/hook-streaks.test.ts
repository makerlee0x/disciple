import { describe, expect, it } from "vitest";
import { aboardDays, DAY, dayIndex, heldIntervals, streakOf, streakPays, STREAKS_FROM, weekIndex } from "@/lib/streaks";

const T = STREAKS_FROM + 20 * DAY + 12 * 3600_000; // midday, 20 days after launch
const t = dayIndex(T);
const buy = (ts: number, usd: number, tokens = usd) => ({ ts, side: "buy" as const, tokens, usd });
const sell = (ts: number, tokens: number, usd = tokens) => ({ ts, side: "sell" as const, tokens, usd });

describe("steady-hand streaks", () => {
  it("weeks start on Monday (UTC)", () => {
    const mon = dayIndex(Date.UTC(2026, 10, 16)), sun = dayIndex(Date.UTC(2026, 10, 15));
    expect(weekIndex(mon)).toBe(weekIndex(mon + 6));
    expect(weekIndex(sun)).toBe(weekIndex(mon) - 1);
  });

  it("holds by cost: a falling price never breaks it, a sell under $5 does", () => {
    expect(heldIntervals([buy(0, 10), sell(100, 4, 1)])).toEqual([[0, Infinity]]); // $6 of cost left
    expect(heldIntervals([buy(0, 10), sell(100, 6, 20)])).toEqual([[0, 100]]); // $4 left
    expect(heldIntervals([buy(0, 4)])).toEqual([]);
  });

  it("a day counts only when held from its 00:00 to its end; a buy mid-day starts tomorrow", () => {
    const { days, today } = aboardDays([[buy((t - 3) * DAY + 5000, 10)]], T);
    expect([...days].sort()).toEqual([t - 2, t - 1]);
    expect(today).toBe(true);
    const late = aboardDays([[buy(t * DAY + 1000, 10)]], T);
    expect(late.days.size).toBe(0);
    expect(late.today).toBe(false);
  });

  it("one missed day a week is paused; a second resets", () => {
    const done = new Set<number>();
    for (let d = t - 10; d < t; d++) done.add(d);
    done.delete(t - 5);
    const a = streakOf(done, T, { todayCounts: false, todayOk: false });
    expect(a.current).toBe(9);
    expect(a.week.find((x) => x.day === t - 5)?.state).toBe("paused");
    if (weekIndex(t - 5) === weekIndex(t - 4)) {
      done.delete(t - 4);
      const b = streakOf(done, T, { todayCounts: false, todayOk: false });
      expect(b.current).toBe(3);
    }
  });

  it("today never breaks it; check-in counts today", () => {
    const done = new Set([t - 2, t - 1]);
    expect(streakOf(done, T, { todayCounts: false, todayOk: false }).current).toBe(2);
    done.add(t);
    const c = streakOf(done, T, { todayCounts: true, todayOk: true });
    expect(c.current).toBe(3);
    expect(c.week[6].state).toBe("done");
  });

  it("pays 20 a day and 100 at 7-day marks, nothing before launch", () => {
    const done = new Set<number>();
    for (let d = dayIndex(STREAKS_FROM) - 3; d < t; d++) done.add(d);
    const p = streakPays("aboard", streakOf(done, T, { todayCounts: false, todayOk: false }));
    expect(p.every((x) => x.ts >= STREAKS_FROM)).toBe(true);
    expect(p.filter((x) => x.xp === 20)).toHaveLength(20);
    expect(p.filter((x) => x.xp === 100).length).toBeGreaterThan(0);
    expect(new Set(p.map((x) => x.src)).size).toBe(p.length);
  });
});

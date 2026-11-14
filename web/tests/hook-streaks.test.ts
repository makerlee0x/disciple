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
    const { days, today } = aboardDays([{ fills: [buy((t - 3) * DAY + 5000, 10)] }], T);
    expect([...days].sort()).toEqual([t - 2, t - 1]);
    expect(today).toBe(true);
    const late = aboardDays([{ fills: [buy(t * DAY + 1000, 10)] }], T);
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

  it("a transfer away ends the hold, and days past the transfer scan don't count yet", () => {
    const fills = [buy((t - 5) * DAY - 1000, 10), { ts: (t - 3) * DAY + 5000, side: "sell" as const, tokens: 10, usd: 0 }];
    expect([...aboardDays([{ fills }], T).days].sort()).toEqual([t - 5, t - 4]);
    const held = [buy((t - 5) * DAY - 1000, 10)];
    expect([...aboardDays([{ fills: held, verifiedTo: (t - 3) * DAY }], T).days].sort()).toEqual([t - 5, t - 4]);
    expect(aboardDays([{ fills: held, verifiedTo: -Infinity }], T).days.size).toBe(0);
  });

  it("day numbers stay fixed as time passes, so marks never move (no rolling window)", () => {
    const done = new Set<number>();
    const from = dayIndex(STREAKS_FROM);
    for (let d = from; d < from + 200; d++) done.add(d);
    const at = (days: number) => streakPays("checkin", streakOf(done, (from + days) * DAY + 3600_000, { todayCounts: true, todayOk: true }));
    const early = new Map(at(70).map((p) => [p.src, p.xp])), late = at(140);
    // every mark paid at day 70 is still a mark at day 140, and no day before 70 turned into a new mark
    for (const p of late) if (p.xp === 100 && p.ts < (from + 70) * DAY) expect(early.get(p.src)).toBe(100);
    expect(late.filter((p) => p.xp === 100)).toHaveLength(Math.floor(141 / 7));
  });

  it("a folded transfer history (two exits merged into one earlier one) never revives the rebought bag", () => {
    const out = (ts: number, tokens: number) => ({ ts, side: "sell" as const, tokens, usd: 0, out: true });
    // real order: buy 10, send 10 away, rebuy 10, send 10 away. The scan folded both sends into one 20 at the first
    const folded = [buy(0, 10), out(100, 20), buy(200, 10)];
    expect(heldIntervals(folded)).toEqual([[0, 100]]);
    // a real top-up after the debt is paid still counts
    expect(heldIntervals([...folded, buy(300, 10)])).toEqual([[0, 100], [300, Infinity]]);
  });
});

import { describe, expect, it } from "vitest";
import { scoreClimbRun } from "@/lib/server/climbRecord";

const run = { level: 1, stake: 12, startAt: 1_000_000, endAt: 1_060_000 };
const f = (at: number, usd: number, pnl: number | null, fee = 0.001) => ({ at, market: "BTC", usd, fee, pnl });

describe("scoreClimbRun", () => {
  it("clears the level when net PnL after fees hits its goal ($0.12 on $12 at level 1)", () => {
    const r = scoreClimbRun(run, [f(1_005_000, 120, null), f(1_030_000, 120, 0.15)]);
    expect(r.net).toBeCloseTo(0.148);
    expect(r.cleared).toBe(1);
    expect(r.clearMs).toBe(30_000);
  });
  it("fees can make a run miss", () => {
    expect(scoreClimbRun(run, [f(1_005_000, 120, null, 0.02), f(1_030_000, 120, 0.13, 0.02)]).cleared).toBe(0);
  });
  it("a tiny claimed stake can't shrink the goal: the biggest fill over the gear sets it", () => {
    // $2 claimed, but a $1,200 position at 10x is a $120 stake: the goal is $1.20, not $0.02
    const r = scoreClimbRun({ ...run, stake: 2 }, [f(1_005_000, 1200, null), f(1_030_000, 1200, 0.5)]);
    expect(r.stake).toBe(120);
    expect(r.cleared).toBe(0);
  });
  it("ignores other markets and fills outside the run", () => {
    const r = scoreClimbRun(run, [f(900_000, 120, 5), { ...f(1_010_000, 120, 5), market: "ETH" }]);
    expect(r.cleared).toBe(0);
    expect(r.fills).toBe(0);
  });
  it("beating a higher level's goal jumps past the levels below it", () => {
    // $12 stake: level 3's goal is 5% = $0.60
    expect(scoreClimbRun(run, [f(1_005_000, 120, null, 0), f(1_030_000, 120, 0.61, 0)]).cleared).toBe(2);
  });
});

import { PRESEASON_START, SEASON_ONE_START, SEASON_MS, rankSeasonAt } from "@/lib/duel/season";
describe("pre-season counts toward Season 1 (maker 2026-11-20)", () => {
  it("before Dec 1: Season 1, window from the pre-season start, ends 12 weeks after Dec 1", () => {
    const s = rankSeasonAt(PRESEASON_START + 3_600_000);
    expect(s).toMatchObject({ id: "s1", n: 1, startsAt: PRESEASON_START, endsAt: SEASON_ONE_START + SEASON_MS });
  });
  it("after Dec 1, Season 1 keeps the pre-season trades; Season 2 starts clean", () => {
    expect(rankSeasonAt(SEASON_ONE_START + 86_400_000).startsAt).toBe(PRESEASON_START);
    expect(rankSeasonAt(SEASON_ONE_START + SEASON_MS + 1)).toMatchObject({ id: "s2", startsAt: SEASON_ONE_START + SEASON_MS });
  });
});

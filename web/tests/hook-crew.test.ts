import { describe, expect, it } from "vitest";
import { crewAboardNow, crewOnCoin, crewRecord, flyPath } from "@/lib/crew";
import type { LogFill } from "@/lib/logbook";

const H = 3600_000;
const ME = "0x" + "a".repeat(40), JO = "0x" + "b".repeat(40), RA = "0x" + "c".repeat(40), XX = "0x" + "d".repeat(40);
let n = 0;
const f = (trader: string, side: "buy" | "sell", ts: number, usd: number, mcapUsd = 10_000): LogFill => ({ ts, block: ++n, logIndex: 0, trader, side, tokens: usd, usd, mcapUsd });

describe("crew flights", () => {
  const now = 100 * H, week = 90 * H;
  it("counts rockets flown together, the longest shared stay, orbit with crew", () => {
    const fills = [f(ME, "buy", 91 * H, 10), f(JO, "buy", 92 * H, 10), f(RA, "buy", 92.5 * H, 10), f(JO, "sell", 95 * H, 10), f(XX, "buy", 96 * H, 50, 40_000)];
    const r = crewOnCoin(fills, ME, new Set([JO, RA]), now, week, true);
    expect(r.together).toBe(true);
    expect(r.longestMs).toBe(7.5 * H); // with ra, to now
    expect(r.orbit).toBe(true); // orbit fill at 96h, ra aboard with you
    expect(r.aboardNow).toEqual([RA]);
    expect(r.missionBest).toBe(3); // you, jo, ra all aboard 92.5h–93.5h
  });
  it("dust and strangers never count", () => {
    const fills = [f(ME, "buy", 91 * H, 10), f(JO, "buy", 92 * H, 2), f(XX, "buy", 92 * H, 100)];
    const r = crewOnCoin(fills, ME, new Set([JO]), now, week, false);
    expect(r.together).toBe(false);
    expect(r.missionBest).toBe(1);
    expect(crewAboardNow(fills, new Set([JO]), now)).toEqual([]);
  });
  it("mission needs a full hour inside this week", () => {
    const fills = [f(ME, "buy", 80 * H, 10), f(JO, "buy", 80 * H, 10), f(RA, "buy", 80 * H, 10), f(RA, "sell", 90.5 * H, 10)];
    expect(crewOnCoin(fills, ME, new Set([JO, RA]), now, week, false).missionBest).toBe(2);
  });
  it("record sums and the fly link is lower case", () => {
    expect(crewRecord([{ together: true, orbit: true, longestMs: 5, aboardNow: [], missionBest: 1 }, { together: true, orbit: false, longestMs: 9, aboardNow: [], missionBest: 1 }])).toEqual({ together: 2, orbits: 1, longestMs: 9 });
    expect(flyPath("MK", "MOTH")).toBe("/fly/mk/moth");
  });
});

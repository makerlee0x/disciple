import { describe, expect, it } from "vitest";
import { BOARD_RULES, bestCalls, gapToNext, pilotBoard, rankBoard, topPilots } from "@/lib/home/topPilots";
import type { Fill } from "@/lib/trades";

const H = 3600_000, NOW = 100 * H;
let n = 0;
const f = (trader: string, coin: string, side: "buy" | "sell", tokens: number, usd: number, ts: number, mcapUsd = 0): Fill =>
  ({ id: `t${n}:0`, tx: `t${n}`, logIndex: 0, block: ++n, ts, coin, trader, side, venue: "curve", tokens, usd, priceUsd: usd / tokens, mcapUsd }) as Fill;

describe("pilotBoard", () => {
  const fills = [
    [f("0xa", "c1", "buy", 100, 100, NOW - 5 * H), f("0xa", "c1", "sell", 100, 150, NOW - 2 * H), f("0xb", "c1", "buy", 10, 20, NOW - 3 * H)],
    [f("0xb", "c2", "buy", 50, 50, NOW - 40 * H), f("0xb", "c2", "sell", 50, 150, NOW - 30 * H), f("0xa", "c2", "buy", 10, 10, NOW - 1 * H)],
  ];
  const b = pilotBoard(fills, NOW);
  it("realized profit, best % and flights per window", () => {
    const a = b.day.find((p) => p.wallet === "0xa")!;
    expect(a.pnlUsd).toBe(50);
    expect(a.bestPct).toBe(50);
    expect(a.flights).toBe(2);
    expect(a.boostedUsd).toBe(110);
    expect(b.day.find((p) => p.wallet === "0xb")!.pnlUsd).toBe(0);
    expect(b.week.find((p) => p.wallet === "0xb")!.pnlUsd).toBe(100);
  });
  it("longest aboard: a closed hold, and a hold still open up to now (clipped to the window)", () => {
    expect(b.day.find((p) => p.wallet === "0xa")!.aboardMs).toBe(3 * H);
    expect(b.day.find((p) => p.wallet === "0xb")!.aboardMs).toBe(3 * H);
    expect(b.week.find((p) => p.wallet === "0xb")!.aboardMs).toBe(10 * H);
  });
  it("ranks cash-outs only for winners, and the gap to the next place", () => {
    const week = rankBoard(b.week, "pnl");
    expect(week.map((p) => p.wallet)).toEqual(["0xb", "0xa"]);
    expect(gapToNext(week, 1, "pnl")).toBe(50);
    expect(rankBoard(b.day, "pnl").map((p) => p.wallet)).toEqual(["0xa"]);
  });
  it("record: green and red rockets, losses", () => {
    const loss = [[f("0xc", "c3", "buy", 10, 100, NOW - 5 * H), f("0xc", "c3", "sell", 10, 40, NOW - 4 * H)], [f("0xc", "c4", "buy", 10, 10, NOW - 5 * H), f("0xc", "c4", "sell", 10, 30, NOW - 4 * H)]];
    const c = pilotBoard(loss, NOW).day.find((p) => p.wallet === "0xc")!;
    expect([c.green, c.red, c.lostUsd, c.pnlUsd]).toEqual([1, 1, 60, -40]);
  });
});

describe("board guardrails (maker, Nov 13)", () => {
  it("a host's own rocket never counts", () => {
    const fills = [[f("0xh", "c9", "buy", 100, 10, NOW - 5 * H), f("0xh", "c9", "sell", 100, 500, NOW - 4 * H), f("0xa", "c9", "buy", 1, 30, NOW - 5 * H), f("0xa", "c9", "sell", 1, 60, NOW - 4 * H)]];
    const o = { creators: new Map([["c9", "0xH"]]) };
    expect(topPilots(fills, NOW, 5, o).day.map((p) => p.wallet)).toEqual(["0xa"]);
    expect(pilotBoard(fills, NOW, o).day.find((p) => p.wallet === "0xh")).toBeUndefined();
    expect(topPilots(fills, NOW).day[0].wallet).toBe("0xh"); // without the rule it would win
  });
  it("a cash-out counts only after 2 minutes aboard", () => {
    const t = NOW - H;
    const quick = [[f("0xq", "c5", "buy", 10, 50, t), f("0xq", "c5", "sell", 10, 90, t + BOARD_RULES.minAboardMs - 1)]];
    const slow = [[f("0xq", "c5", "buy", 10, 50, t), f("0xq", "c5", "sell", 10, 90, t + BOARD_RULES.minAboardMs)]];
    expect(topPilots(quick, NOW).day).toEqual([]);
    expect(topPilots(slow, NOW).day[0]).toMatchObject({ wallet: "0xq", pnlUsd: 40, flights: 1, green: 1 });
  });
  it("Best % needs $20 put in", () => {
    const tiny = [[f("0xt", "c6", "buy", 10, 1, NOW - 5 * H), f("0xt", "c6", "sell", 10, 80, NOW - 4 * H)]];
    expect(pilotBoard(tiny, NOW).day[0].bestPct).toBeNull();
    expect(rankBoard(pilotBoard(tiny, NOW).day, "pctGain")).toEqual([]);
    expect(bestCalls(tiny, NOW).day).toBeNull();
  });
  it("Best call: the biggest climb, with the boarding and cash-out mcap", () => {
    const fills = [
      [f("0xk", "c7", "buy", 10, 40, NOW - 50 * H, 5_000), f("0xk", "c7", "sell", 10, 296, NOW - 4 * H, 70_000)],
      [f("0xm", "c8", "buy", 10, 100, NOW - 5 * H, 12_000), f("0xm", "c8", "sell", 10, 300, NOW - 4 * H, 30_000)],
    ];
    const c = bestCalls(fills, NOW).day!;
    expect(c).toMatchObject({ wallet: "0xk", coin: "c7", pct: 640, basisUsd: 40, boardedMcap: 5_000, cashedMcap: 70_000, aboardMs: 46 * H });
  });
  it("orbits aboard: holders at the first fill past the orbit line of a graduated rocket", () => {
    const fills = [[f("0xa", "g1", "buy", 10, 50, NOW - 5 * H, 20_000), f("0xb", "g1", "buy", 10, 50, NOW - 4 * H, 34_000), f("0xc", "g1", "buy", 10, 50, NOW - 3 * H, 40_000)]];
    const b = pilotBoard(fills, NOW, { graduated: new Set(["g1"]) });
    expect(rankBoard(b.day, "orbits").map((p) => p.wallet).sort()).toEqual(["0xa", "0xb"]);
    expect(rankBoard(pilotBoard(fills, NOW).day, "orbits")).toEqual([]);
  });
});

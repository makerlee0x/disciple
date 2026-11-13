import { describe, expect, it } from "vitest";
import { gapToNext, pilotBoard, rankBoard } from "@/lib/home/topPilots";
import type { Fill } from "@/lib/trades";

const H = 3600_000, NOW = 100 * H;
let n = 0;
const f = (trader: string, coin: string, side: "buy" | "sell", tokens: number, usd: number, ts: number): Fill =>
  ({ id: `t${n}:0`, tx: `t${n}`, logIndex: 0, block: ++n, ts, coin, trader, side, venue: "curve", tokens, usd, priceUsd: usd / tokens, mcapUsd: 0 }) as Fill;

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
    expect(rankBoard(b.day, "volume").map((p) => p.wallet)).toEqual(["0xa", "0xb"]);
  });
});

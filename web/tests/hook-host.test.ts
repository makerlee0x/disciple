import { describe, expect, it } from "vitest";
import { headlineMark, hostLogLine, hostStats } from "@/lib/host";
import type { LogFill } from "@/lib/logbook";

const HOST = "0x" + "0".repeat(39) + "1";
const p = (i: number) => "0x" + i.toString(16).padStart(40, "0");
let n = 0;
const f = (trader: string, side: "buy" | "sell", ts: number, mcapUsd: number): LogFill => ({ ts, block: ++n, logIndex: 0, trader, side, tokens: 1, usd: 1, mcapUsd });

describe("host mission control", () => {
  it("counts passengers (host excluded), peak, milestones and first crew", () => {
    const fills: LogFill[] = [f(HOST, "buy", 0, 4_000)];
    for (let i = 2; i < 14; i++) fills.push(f(p(i), "buy", i * 1000, 4_000 + i * 1_000));
    fills.push(f(p(2), "sell", 20_000, 15_000));
    const tags: Record<string, string | null> = { [p(3)]: "u-a", [p(5)]: "u-a" };
    const h = hostStats(fills, HOST, { now: 30_000, graduated: false, launchedAt: 0, tags });
    expect(h.passengers).toBe(11);
    expect(h.peak).toBe(12);
    const m = Object.fromEntries(h.milestones.map((x) => [x.key, x.at]));
    expect(m.p10).toBe(11_000);
    expect(m.crew).toBe(5_000);
    expect(m["z:OZONE"]).toBe(8_000);
    expect(m.orbit).toBeNull();
    expect(h.series[0].n).toBe(0);
    expect(h.series[h.series.length - 1].n).toBe(11);
  });
  it("share copy counts people and zones only", () => {
    expect(hostLogLine({ passengers: 52, crews: 4, zone: "KÁRMÁN LINE", day: 3 })).toBe("4 crews aboard · in the Kármán Line · day 3");
    expect(headlineMark(52)).toBe(50);
    expect(headlineMark(7)).toBe(7);
  });
});

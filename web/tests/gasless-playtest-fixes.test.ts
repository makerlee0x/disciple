/** maker's live play-test 2026-11-14 (8:15 PM CT): chart card + relay refusal copy. */
import { describe, expect, it } from "vitest";
import { windowBars, windowChange } from "../components/flight/PhoneChart";
import { relayRefusalCopy } from "../lib/protocol-viem";

describe("flight chart card", () => {
  const now = 1_000_000;
  it("a quiet minute keeps the chart: the last price carries forward as flat bars (was: 'Reading the market…')", () => {
    const pts = [{ t: now - 120_000, m: 5000 }];   // last mark 2 min ago, 1M window
    const bars = windowBars(pts, now, 60_000);
    expect(bars).toHaveLength(30);
    expect(bars.every((b) => b && b.empty && b.c === 5000)).toBe(true);
    expect(windowChange([{ t: now - 120_000, m: 5000 }, { t: now - 90_000, m: 6000 }], now, 60_000)).toBe(0);
  });
  it("candles open at the previous close and carry trades' highs and lows", () => {
    const pts = [{ t: now - 59_000, m: 100 }, { t: now - 58_500, m: 120 }, { t: now - 58_200, m: 90 }, { t: now - 1_000, m: 150 }];
    const bars = windowBars(pts, now, 60_000);
    expect(bars[0]).toMatchObject({ o: 100, h: 120, l: 90, c: 90, empty: false });
    expect(bars[1]).toMatchObject({ o: 90, c: 90, empty: true });
    expect(bars[29]).toMatchObject({ o: 90, h: 150, c: 150, empty: false });
  });
  it("nothing before the first price is drawn", () => {
    const bars = windowBars([{ t: now - 10_000, m: 10 }], now, 60_000);
    expect(bars.slice(0, 20).every((b) => b === null)).toBe(true);
    expect(bars[29]?.c).toBe(10);
  });
});

describe("relay refusal copy (was always \"That didn't go through. Try again.\")", () => {
  it("names the real reason in plain words", () => {
    expect(relayRefusalCopy("relay paused: relayer loss circuit open; nothing sent, try again later")?.msg).toMatch(/paused/);
    expect(relayRefusalCopy("relay rate limited")).toEqual({ code: "rate_limited", msg: "Slow down" });
    expect(relayRefusalCopy("sender in relay strike backoff; no submission")?.msg).toMatch(/Wait a minute/);
    expect(relayRefusalCopy("simulation failed: execution reverted")).toBeNull();
  });
});

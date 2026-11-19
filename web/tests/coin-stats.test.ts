import { describe, expect, it } from "vitest";
import { dayWindow, fmtCount, fmtPrice, fmtUsdShort, positionAmounts } from "@/lib/coinStats";

const H = 3_600_000, now = 100 * H;
const f = (ts: number, mcapUsd: number, usd: number, side: "buy" | "sell" = "buy") => ({ ts, mcapUsd, usd, side });

describe("dayWindow", () => {
  it("sums the last 24 h and compares with the last fill before it", () => {
    const r = dayWindow([f(now - 30 * H, 1000, 50), f(now - 25 * H, 2000, 40), f(now - 2 * H, 3000, 10), f(now - H, 1500, 5, "sell")], now, 1000);
    expect(r.vol24hUsd).toBe(15);
    expect(r.change24hPct).toBeCloseTo(-50);
  });
  it("a young coin compares with its first fill; router $ wins", () => {
    const r = dayWindow([{ ...f(now - 2 * H, 4000, 10), usdIn: 12 }, f(now - H, 8000, 20)], now);
    expect(r.vol24hUsd).toBe(32);
    expect(r.change24hPct).toBeCloseTo(100);
  });
  it("no fills", () => { expect(dayWindow([], now)).toEqual({ vol24hUsd: 0, change24hPct: null }); });
});

describe("positionAmounts", () => {
  it("in range holds both sides; above / below holds one", () => {
    const L = 1e6, sp = 1;
    const a = positionAmounts(L, -1000, 1000, sp); expect(a.a0).toBeGreaterThan(0); expect(a.a1).toBeGreaterThan(0);
    const below = positionAmounts(L, 100, 1000, sp); expect(below.a1).toBe(0); expect(below.a0).toBeGreaterThan(0);
    const above = positionAmounts(L, -1000, -100, sp); expect(above.a0).toBeCloseTo(0); expect(above.a1).toBeGreaterThan(0);
  });
});

describe("formats", () => {
  it("matches the DEX row", () => {
    expect(fmtPrice(0.000816)).toBe("$0.000816");
    expect(fmtPrice(0.0014)).toBe("$0.0014");
    expect(fmtPrice(1.5)).toBe("$1.50");
    expect(fmtUsdShort(813_400)).toBe("$813K");
    expect(fmtUsdShort(73_700)).toBe("$73.7K");
    expect(fmtUsdShort(1_400)).toBe("$1.4K");
    expect(fmtUsdShort(12)).toBe("$12");
    expect(fmtCount(9_000)).toBe("9K");
    expect(fmtCount(42_000)).toBe("42K");
    expect(fmtCount(312)).toBe("312");
  });
});

// maker 2026-11-18 $MOON play-test: a BOOST over the router's per-trade price cap is cut to the max instead of failing,
// and the chart has a 1D range.
import { describe, expect, it } from "vitest";
import { maxBuyUnderCap } from "@/lib/flight/tradeGate";
import { CHART_TFS } from "@/components/flight/PhoneChart";

describe("maxBuyUnderCap", () => {
  // a constant-product pool with $1,100 of quote-side depth: impact(a) = (1 + a/y)² − 1
  const y = 1100, imp = (a: number) => Math.round(((1 + a / y) ** 2 - 1) * 10000);
  it("is null when there is no cap or nothing is over it", () => {
    expect(maxBuyUnderCap([10, 25], [imp(10), imp(25)], 0)).toBeNull();
    expect(maxBuyUnderCap([10, 25], [imp(10), imp(25)], 50000)).toBeNull();
  });
  it("sizes a $5K BOOST on a thin pool to just under a 500% cap", () => {
    const cap = 50000, m = maxBuyUnderCap([100, 5000], [imp(100), imp(5000)], cap)!;
    expect(m).toBeGreaterThan(0); expect(m).toBeLessThan(5000);
    expect(imp(m)).toBeLessThan(cap);
    expect(imp(m / 0.92)).toBeGreaterThanOrEqual(cap - 5);   // without the margin it sits on the cap
  });
});

describe("chart ranges", () => {
  it("offers 1M · 5M · 1H · 1D", () => { expect(CHART_TFS.map((t) => t.k)).toEqual(["1M", "5M", "1H", "1D"]); });
});

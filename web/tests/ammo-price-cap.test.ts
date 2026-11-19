// maker 2026-11-18 $MOON play-test: the chart has a 1D range. (The BOOST MAX clip is gone: no trade size cap, 2026-11-19.)
import { describe, expect, it } from "vitest";
import { CHART_TFS } from "@/components/flight/PhoneChart";

describe("chart ranges", () => {
  it("offers 1M · 5M · 1H · 1D", () => { expect(CHART_TFS.map((t) => t.k)).toEqual(["1M", "5M", "1H", "1D"]); });
});

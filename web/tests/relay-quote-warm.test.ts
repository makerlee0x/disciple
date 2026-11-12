import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TtlCache } from "../lib/trade/hotCache";
it("retains the 1500ms quote freshness limit even when warming is delayed", () => {
  let now = 0; const cache = new TtlCache<bigint>(1500, () => now); cache.set("quote", 9n);
  now = 1500; expect(cache.fresh("quote")).toBe(9n);
  now = 1501; expect(cache.fresh("quote")).toBeUndefined();
});
it("starts buy warming before independent balance lookup and keeps exact quote/live fallback", () => {
  const bridge = readFileSync(new URL("../components/TradeBridge.tsx", import.meta.url), "utf8");
  const loop = bridge.slice(bridge.indexOf("// HOT PATH warm-up"), bridge.indexOf("// Preview for the selected ammo"));
  expect(loop.indexOf("const buy = shotAmountIn")).toBeLessThan(loop.indexOf("await activeAddress()"));
  expect(loop).toContain("cfgRef.current.sells.map"); expect(loop).toContain("if (warming) return warming");
  expect(loop).toContain("setInterval(() => void tick(), 750)"); expect(loop).toContain('"visibilitychange"');
  const protocol = readFileSync(new URL("../lib/protocol-viem.ts", import.meta.url), "utf8");
  expect(protocol).toContain("amountIn, 0, connectedAddress(), true)");
});

import { describe, expect, it } from "vitest";
import { tapPending } from "../lib/trade/tapPending";
import { writeFileSync } from "node:fs";
describe("pending on tap, never a final fill", () => {
  it("synchronously emits the existing sent wire before any build/sign work", () => {
    const phases: string[] = [];
    tapPending("press", "buy", e => { const d = (e as CustomEvent).detail; phases.push(d.stage); expect(d.pending).toBe(true); expect(d.phase).toBe("sent"); expect(d.success).toBeUndefined(); });
    phases.push("build", "sign"); expect(phases).toEqual(["tap", "build", "sign"]);
  });
  it("measures synchronous event dispatch proxy (not a browser paint or chain receipt)", () => {
    const times: number[] = [];
    for (let i = 0; i < 10000; i++) { const t = performance.now(); tapPending(String(i), "buy", () => times.push(performance.now() - t)); }
    times.sort((a,b) => a-b);
    const result = { samples: times.length, meanMs: times.reduce((a,b)=>a+b,0)/times.length, p50Ms: times[5000], p95Ms: times[9500], maxMs: times[9999], meaning: "node synchronous tap-to-pending-event proxy, not browser paint" };
    writeFileSync("/workspace/self-bundler-tap-timing.json", JSON.stringify(result, null, 2));
    expect(result.p95Ms).toBeLessThan(100);
  });
});

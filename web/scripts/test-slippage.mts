// Unit tests for the one-tap session slippage clamp (lib/aa/slippage.ts).  pnpm test:slippage
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_SLIPPAGE_BPS, clampSlippage, suggestedSessionMax, pct } from "../lib/aa/slippage";

test("no session: passes the request through untouched", () => {
  assert.deepEqual(clampSlippage(undefined, null), { bps: undefined, capped: false, requestedBps: AUTO_SLIPPAGE_BPS, sessionMaxBps: null });
  assert.equal(clampSlippage(3000, null).bps, 3000);
  assert.equal(clampSlippage(3000, undefined).capped, false);
  assert.equal(clampSlippage(3000, 0).capped, false);
});
test("under the session max: unchanged", () => {
  assert.deepEqual(clampSlippage(200, 500), { bps: 200, capped: false, requestedBps: 200, sessionMaxBps: 500 });
  assert.equal(clampSlippage(500, 500).capped, false); // equal is allowed (not flagged)…
  assert.equal(clampSlippage(500, 500).bps, 450); // …but kept 50 bps under the policy floor
  assert.equal(clampSlippage(undefined, 500).bps, undefined); // auto 1% < 5%
});
test("above the session max: capped to the max minus quote headroom (50 bps)", () => {
  const c = clampSlippage(2000, 500);
  assert.equal(c.bps, 450); assert.equal(c.capped, true); assert.equal(c.requestedBps, 2000);
  assert.equal(suggestedSessionMax(c), 2000);
  assert.equal(pct(c.bps!), "4.5%"); assert.equal(pct(c.sessionMaxBps!), "5%"); // UI shows the session max (disciple:slippagecap maxBps)
});
test("auto slippage above a tiny session max is capped too", () => {
  const c = clampSlippage(undefined, 10);
  assert.equal(c.bps, 10); assert.equal(c.capped, true); assert.equal(pct(10), "0.1%");
});
test("suggestion never exceeds the 50% policy limit; bad input = auto", () => {
  assert.equal(suggestedSessionMax(clampSlippage(9000, 500)), 5000);
  assert.equal(clampSlippage(NaN, 500).requestedBps, AUTO_SLIPPAGE_BPS);
  assert.equal(clampSlippage(-5, 500).bps, undefined);
});

// Pure checks for the funnel counter keys and day math (lib/funnel.ts).   pnpm test:funnel
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FUNNEL_STEPS, dayKey, funnelNet, isFunnelStep, lastDays, nextUtcDay, totalKey, utcDay } from "../lib/funnel.ts";

test("six steps, in funnel order", () => {
  assert.deepEqual([...FUNNEL_STEPS], ["land", "signin", "fund", "first_trade", "first_launch", "return_d1"]);
  for (const s of FUNNEL_STEPS) assert.ok(isFunnelStep(s));
  for (const s of ["", "LAND", "land ", "visit", null, 1, {}]) assert.equal(isFunnelStep(s), false);
});

test("keys carry the network and are counts only", () => {
  assert.equal(dayKey("46630", "land", "2026-10-26"), "fun:46630:land:d:2026-10-26");
  assert.equal(totalKey("46630", "first_trade"), "fun:46630:first_trade:all");
  assert.equal(funnelNet(46630, "production"), "46630");
  assert.equal(funnelNet(46630, undefined), "46630");
  assert.equal(funnelNet(46630, "preview"), "preview");
});

test("UTC day math (return next day)", () => {
  assert.equal(utcDay(Date.parse("2026-10-26T23:59:59Z")), "2026-10-26");
  assert.equal(nextUtcDay("2026-10-26"), "2026-10-27");
  assert.equal(nextUtcDay("2026-10-31"), "2026-11-01");
  assert.equal(nextUtcDay("2026-12-31"), "2027-01-01");
  const d = lastDays(Date.parse("2026-10-26T12:00:00Z"), 3);
  assert.deepEqual(d, ["2026-10-24", "2026-10-25", "2026-10-26"]);
  assert.equal(lastDays(0, 0).length, 1);
  assert.equal(lastDays(0, 1000).length, 90);
});

test("the route stores no personal data (only the step and counters)", () => {
  const src = readFileSync(new URL("../app/api/funnel/route.ts", import.meta.url), "utf8");
  assert.ok(!/\.set\(|setNX|zadd|sadd/.test(src), "funnel route must only INCR counters");
  assert.ok(/createHash\("sha256"\)/.test(src), "IP only appears hashed, in the rate-limit key");
});

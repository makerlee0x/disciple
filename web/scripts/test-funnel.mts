// Pure checks for the funnel counter keys and day math (lib/funnel.ts).   pnpm test:funnel
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FUNNEL_STEPS, IMPLIES, INSTALL_FUNNEL, REF_FUNNEL, REF_TWIN, dayKey, funnelNet, funnelRows, funnelSource, isFunnelSource, isFunnelStep, lastDays, nextUtcDay, srcDayKey, srcTotalKey, totalKey, utcDay } from "../lib/funnel.ts";

test("six steps, in funnel order", () => {
  assert.deepEqual([...FUNNEL_STEPS], ["land", "signin", "fund", "first_trade", "first_launch", "return_d1", "duel_start", "duel_finish", "duel_share", "duel_join", "duel_rematch", "duel_request", "royale_join", "first_play", "first_share", "ref_land", "ref_signin", "ref_trade"]);
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

test("install-to-trade and referral funnels only use known steps; implied steps are known too", () => {
  assert.deepEqual([...INSTALL_FUNNEL], ["land", "first_play", "signin", "fund", "first_trade", "first_share"]);
  assert.deepEqual([...REF_FUNNEL], ["ref_land", "ref_signin", "ref_trade"]);
  for (const s of [...INSTALL_FUNNEL, ...REF_FUNNEL, ...Object.keys(IMPLIES), ...Object.values(IMPLIES), ...Object.keys(REF_TWIN), ...Object.values(REF_TWIN)]) assert.ok(isFunnelStep(s), s);
  assert.equal(IMPLIES.duel_start, "first_play");
  assert.equal(IMPLIES.duel_share, "first_share");
  assert.equal(REF_TWIN.first_trade, "ref_trade");
});

test("source: app shell, X's browser, everything else", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  assert.equal(funnelSource(`${iphone} DiscipleApp/1`), "app");
  assert.equal(funnelSource(iphone, true), "app");
  assert.equal(funnelSource(`${iphone} Twitter for iPhone/10.62`), "x");
  assert.equal(funnelSource("Mozilla/5.0 (Linux; Android 14; wv) TwitterAndroid"), "x");
  assert.equal(funnelSource(iphone), "web");
  assert.equal(funnelSource(""), "web");
  for (const s of ["app", "x", "web"]) assert.ok(isFunnelSource(s));
  for (const s of ["", "X", "ios", null, 3]) assert.equal(isFunnelSource(s), false);
  assert.equal(srcDayKey("46630", "land", "app", "2026-11-21"), "fun:46630:land:s:app:d:2026-11-21");
  assert.equal(srcTotalKey("46630", "first_trade", "x"), "fun:46630:first_trade:s:x:all");
});

test("funnel rows: share of first and of previous step, null on zero", () => {
  const r = funnelRows(INSTALL_FUNNEL, { land: 200, first_play: 100, signin: 50, fund: 0, first_trade: 0 });
  assert.deepEqual(r.map((x) => x.n), [200, 100, 50, 0, 0, 0]);
  assert.equal(r[0].ofTop, 1); assert.equal(r[0].ofPrev, null);
  assert.equal(r[1].ofTop, 0.5); assert.equal(r[1].ofPrev, 0.5);
  assert.equal(r[2].ofTop, 0.25); assert.equal(r[2].ofPrev, 0.5);
  assert.equal(r[3].ofPrev, 0); assert.equal(r[4].ofPrev, null);
  assert.ok(funnelRows(INSTALL_FUNNEL, {}).every((x) => x.ofTop === null));
});

test("the route splits by source and never trusts the source for anything but the key", () => {
  const src = readFileSync(new URL("../app/api/funnel/route.ts", import.meta.url), "utf8");
  assert.ok(/isFunnelSource\(rawSrc\) \? rawSrc : "web"/.test(src), "unknown sources count as web");
});

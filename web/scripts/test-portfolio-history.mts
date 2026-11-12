// Profile r5 portfolio block + holdings row label.   pnpm test:portfolio-history
import test from "node:test";
import assert from "node:assert/strict";
import { portfolioSeries, priceAt, rangeStart, seriesChange, tokenAmountLabel } from "../lib/portfolioHistory.ts";

const H = 3600_000, D = 24 * H, now = 1_800_000_000_000;

test("priceAt: last fill at/before t, launch price before the first fill", () => {
  const f = [{ ts: 10, priceUsd: 1 }, { ts: 20, priceUsd: 2 }, { ts: 30, priceUsd: 3 }];
  assert.equal(priceAt(f, 5, 0.5), 0.5);
  assert.equal(priceAt(f, 10, 0.5), 1);
  assert.equal(priceAt(f, 25, 0.5), 2);
  assert.equal(priceAt(f, 99, 0.5), 3);
  assert.equal(priceAt([], 99, 0.5), 0.5);
});

test("series: ends at cash + holdings at the current price, starts at the old price", () => {
  const coins = [{ tokens: 100, priceNow: 2, fills: [{ ts: now - 2 * D, priceUsd: 1 }, { ts: now - H, priceUsd: 1.9 }] }];
  const s = portfolioSeries(50, coins, "24H", now, 0.1, 10);
  assert.equal(s.length, 10);
  assert.equal(s[0].t, now - D);
  assert.equal(s[0].v, 50 + 100 * 1);
  assert.equal(s[9].v, 50 + 100 * 2);
  assert.equal(seriesChange(s), 100);
});

test("series: no holdings and no cash is flat at zero; ALL starts at the first fill", () => {
  const s = portfolioSeries(0, [], "7D", now, 0.1, 5);
  assert.ok(s.every((p) => p.v === 0));
  assert.equal(seriesChange(s), 0);
  const coins = [{ tokens: 1, priceNow: 1, fills: [{ ts: now - 40 * D, priceUsd: 1 }] }];
  assert.equal(rangeStart("ALL", coins, now), now - 40 * D);
  assert.equal(rangeStart("30D", coins, now), now - 30 * D);
});

test("token amount: grouped count + ticker; short form only when it would not fit", () => {
  assert.equal(tokenAmountLabel(1_240_000, "MWRD"), "1,240,000 $MWRD");
  assert.equal(tokenAmountLabel(64_200.9, "VSPR"), "64,200 $VSPR");
  assert.equal(tokenAmountLabel(0.012345, "TINY"), "0.01235 $TINY");
  assert.equal(tokenAmountLabel(123_456_789_012, "LONGTICKER12"), "123.46B $LONGTICKER12");
  assert.equal(tokenAmountLabel(0, "X"), "0 $X");
});

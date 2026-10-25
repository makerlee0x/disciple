// Unit tests for the TURBO practice math + mock adapter (lib/turbo).  npm run test:turbo
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSlice, feeUsd, fundingDeltaUsd, isLiquidated, liquidationPrice, pnlBreakdown, pricePnlUsd } from "../lib/turbo/math";
import { createFuelStore } from "../lib/turbo/fuel";
import { createMockAdapter } from "../lib/turbo/mockAdapter";
import { getTurboAdapter, isTurboEnabled, resetTurboAdapter } from "../lib/turbo/index";
import type { TurboEvent } from "../lib/turbo/types";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("fees are charged on notional, per side, in bps", () => {
  near(feeUsd(10_000, 5), 5);
  near(feeUsd(10_000, 1), 1);
  near(feeUsd(5_000, 4.5), 2.25);
  near(feeUsd(0, 5), 0);
});

test("price PnL: long and short are mirror images", () => {
  near(pricePnlUsd("long", 10_000, 100, 101), 100);
  near(pricePnlUsd("short", 10_000, 100, 101), -100);
  near(pricePnlUsd("short", 10_000, 100, 99), 100);
});

test("PnL after fees = pnl − open fee − close fee (at mark) + funding", () => {
  const b = pnlBreakdown({ side: "long", sizeUsd: 10_000, entry: 100, price: 101, openFeeUsd: 5, fundingUsd: -0.5, feeBps: 5 });
  near(b.pnlUsd, 100);
  near(b.closeFeeUsdEst, 5.05); // close fee on notional at 101
  near(b.pnlAfterFeesUsd, 100 - 5 - 5.05 - 0.5);
});

test("liquidation price includes fees: value at liq == (1 − k)·C", () => {
  for (const side of ["long", "short"] as const) {
    for (const [C, L, bps, fund] of [[10, 1000, 1, 0], [10, 500, 5, 0.3], [100, 100, 4, -1], [25, 25, 5, 0]] as const) {
      const N = C * L, open = feeUsd(N, bps), k = 0.8;
      const liq = liquidationPrice({ side, collateralUsd: C, sizeUsd: N, entry: 100, openFeeUsd: open, fundingUsd: fund, feeBps: bps, liqLossFrac: k });
      const b = pnlBreakdown({ side, sizeUsd: N, entry: 100, price: liq, openFeeUsd: open, fundingUsd: fund, feeBps: bps });
      near(C + b.pnlAfterFeesUsd, (1 - k) * C, 1e-6);
      assert.ok(side === "long" ? liq < 100 : liq > 100, `${side} liq on the losing side`);
      assert.ok(isLiquidated(side, liq, liq));
    }
  }
});

test("1000× with 1 bp: liquidation ≈ 0.06% away; 5 bp: fees alone wipe the buffer", () => {
  const liq = liquidationPrice({ side: "long", collateralUsd: 10, sizeUsd: 10_000, entry: 100, openFeeUsd: 1, fundingUsd: 0, feeBps: 1, liqLossFrac: 0.8 });
  near((100 - liq) / 100, 0.0006, 1e-5);
  const bad = liquidationPrice({ side: "long", collateralUsd: 10, sizeUsd: 10_000, entry: 100, openFeeUsd: 5, fundingUsd: 0, feeBps: 5, liqLossFrac: 0.8 });
  assert.ok(bad > 100, "liq above entry = instantly liquidated");
});

test("funding: longs pay when rate > 0, shorts receive; scales with time and notional", () => {
  near(fundingDeltaUsd("long", 10_000, 0.0001, 3_600_000), -1);
  near(fundingDeltaUsd("short", 10_000, 0.0001, 3_600_000), 1);
  near(fundingDeltaUsd("long", 10_000, 0.0001, 1_800_000), -0.5);
  near(fundingDeltaUsd("long", 10_000, -0.0001, 3_600_000), 1);
});

test("closeSlice: a 25% slice returns 25% of collateral + 25% of PnL after fees", () => {
  const p = { side: "long" as const, sizeUsd: 10_000, entry: 100, price: 101, openFeeUsd: 5, fundingUsd: 0, feeBps: 5, collateralUsd: 100 };
  const full = closeSlice(p, 1), q = closeSlice(p, 0.25);
  near(full.returnedUsd, 100 + 100 - 5 - 5.05);
  near(q.returnedUsd, full.returnedUsd * 0.25);
  near(q.closeFeeUsd, 5.05 * 0.25);
  assert.equal(closeSlice({ ...p, price: 50 }, 1).returnedUsd, 0, "never below $0");
});

function setup(extra: Parameters<typeof createMockAdapter>[0] = {}) {
  let T = 1_000_000;
  const fuel = createFuelStore({ storage: null, initialUsd: 0 });
  const a = createMockAdapter({ autoStart: false, fuel, now: () => T, startPrices: { BTC: 100, ETH: 10 }, feeBps: 5, liqLossFrac: 0.9, fundingRatePerHour: 0, ...extra });
  const events: TurboEvent[] = [];
  a.onEvent((e) => events.push(e));
  return { a, fuel, events, tick: (ms: number) => { T += ms; a.advance(0); } };
}

test("fuel: add / withdraw, separate store, never below $0", async () => {
  const { a } = setup();
  assert.deepEqual(await a.getFuel(), { usd: 0 });
  const seen: number[] = [];
  a.onFuel((f) => seen.push(f.usd));
  await a.addFuel(50);
  await a.withdrawFuel(20);
  assert.deepEqual(await a.getFuel(), { usd: 30 });
  await assert.rejects(a.withdrawFuel(31));
  await assert.rejects(a.addFuel(-1));
  assert.deepEqual(seen, [50, 30]);
});

test("open → pending → filled; fuel locked; quote matches", async () => {
  const { a, events, tick } = setup();
  await a.addFuel(100);
  const q = a.quote({ market: "BTC", side: "long", collateralUsd: 10, leverage: 100 });
  near(q.sizeUsd, 1000); near(q.openFeeUsd, 0.5); near(q.closeFeeUsd, 0.5);
  const { id } = await a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 100 });
  assert.equal((await a.getFuel()).usd, 90);
  assert.equal(events[0].type, "pending");
  assert.equal((await a.getPositions())[0].status, "pending");
  tick(2000);
  assert.equal(events[1].type, "filled");
  const p = (await a.getPositions())[0];
  assert.equal(p.id, id); assert.equal(p.status, "open"); near(p.liqPrice, q.liqPrice); near(p.pnlAfterFeesUsd, -1);
});

test("open validation: leverage cap, fuel, fee wipe-out", async () => {
  const { a } = setup();
  await a.addFuel(10);
  await assert.rejects(a.open({ market: "BTC", side: "long", collateralUsd: 20, leverage: 10 }), /fuel/);
  await assert.rejects(a.open({ market: "BTC", side: "long", collateralUsd: 5, leverage: 1001 }));
  // 5 bp × 1000 = 50% each way > 10% buffer
  await assert.rejects(a.open({ market: "BTC", side: "long", collateralUsd: 5, leverage: 1000 }), /lower leverage/);
  assert.equal((await a.getFuel()).usd, 10);
});

test("partial close 25% then 100%: fuel back matches the math, events in order", async () => {
  const { a, events } = setup();
  await a.addFuel(100);
  const { id } = await a.open({ market: "BTC", side: "long", collateralUsd: 100, leverage: 10 });
  a.flushFills();
  a.setPrice("BTC", 101);
  await a.close(id, 25);
  const pc = events.find((e) => e.type === "partial-closed")!;
  // N=1000, pnl=10, open=0.5, close=1000*1.01*5bp=0.505 → after fees 8.995; 25% → 25 + 2.24875
  near(pc.returnedUsd!, 25 + 8.995 * 0.25);
  const left = (await a.getPositions())[0];
  near(left.collateralUsd, 75); near(left.sizeUsd, 750); near(left.openFeeUsd, 0.375);
  await a.close(id, 100);
  const c = events.at(-1)!;
  assert.equal(c.type, "closed"); assert.equal(c.reason, "manual");
  near(c.returnedUsd!, 75 + 8.995 * 0.75);
  near((await a.getFuel()).usd, Math.round((100 + 8.995) * 100) / 100, 0.011);
  assert.equal((await a.getPositions()).length, 0);
});

test("liquidation: crossing liqPrice emits liquidated, no fuel back", async () => {
  const { a, events } = setup();
  await a.addFuel(10);
  await a.open({ market: "ETH", side: "short", collateralUsd: 10, leverage: 100 });
  a.flushFills();
  const p = (await a.getPositions())[0];
  a.setPrice("ETH", p.liqPrice * 1.0001);
  const e = events.at(-1)!;
  assert.equal(e.type, "liquidated"); assert.equal(e.returnedUsd, 0);
  assert.equal((await a.getFuel()).usd, 0);
});

test("TP and SL close with reason 'tp' / 'sl'", async () => {
  const { a, events } = setup();
  await a.addFuel(100);
  await a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 10, tpPrice: 102 });
  const { id } = await a.open({ market: "BTC", side: "short", collateralUsd: 10, leverage: 10 });
  a.flushFills();
  await a.setTpSl(id, { slPrice: 101.5 });
  a.setPrice("BTC", 102);
  const closes = events.filter((e) => e.type === "closed").map((e) => e.reason).sort();
  assert.deepEqual(closes, ["sl", "tp"]);
});

test("funding accrues on open positions over time and moves liqPrice", async () => {
  const { a, tick } = setup({ fundingRatePerHour: 0.0001 });
  await a.addFuel(100);
  await a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 10 });
  a.flushFills();
  const before = (await a.getPositions())[0];
  tick(3_600_000);
  const after = (await a.getPositions())[0];
  near(after.fundingUsd, -0.01, 1e-9); // 100 notional × 0.01%/h × 1h
  assert.ok(after.liqPrice > before.liqPrice, "paying funding pulls a long's liq price up");
  near(after.pnlAfterFeesUsd, before.pnlAfterFeesUsd - 0.01, 1e-9);
});

test("failed fill refunds fuel", async () => {
  const { a, events } = setup({ failRate: 1 });
  await a.addFuel(10);
  await a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 10 });
  a.flushFills();
  assert.equal(events.at(-1)!.type, "failed");
  assert.equal((await a.getFuel()).usd, 10);
});

test("getTurboAdapter returns the practice adapter; flag is off by default on the server", () => {
  resetTurboAdapter();
  const a = getTurboAdapter();
  assert.equal(a.kind, "practice");
  assert.ok(a.getMarkets!().every((m) => m.practice && m.maxLeverage === 1000));
  assert.deepEqual(a.getMarkets!().map((m) => m.market), ["BTC", "ETH"]);
  assert.equal(isTurboEnabled(), process.env.NEXT_PUBLIC_TURBO === "1");
});

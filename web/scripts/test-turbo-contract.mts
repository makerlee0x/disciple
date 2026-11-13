// Adapter contract (lib/turbo/contract.ts) run against the stand-in with Nova-shaped params, plus the Nova-only states.
//   npm run test:turbo-contract
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../lib/turbo/mockAdapter";
import { createFuelStore } from "../lib/turbo/fuel";
import { runAdapterContract } from "../lib/turbo/contract";
import { STAND_IN_PARAMS, sideCostBps, minFuelAt } from "../lib/turbo/markets";
import { TurboError, type Market, type TurboEvent } from "../lib/turbo/types";

function standIn(extra: Parameters<typeof createMockAdapter>[0] = {}) {
  let T = 1_000_000;
  const a = createMockAdapter({
    autoStart: false, now: () => T, fuel: createFuelStore({ storage: null, initialUsd: 0 }),
    startPrices: { BTC: 100_000, ETH: 3_500 }, params: STAND_IN_PARAMS, ...extra,
  });
  return {
    a,
    clock: (ms: number) => { T += ms; a.advance(0); },
    harness: {
      adapter: a,
      fund: async (usd: number) => { await a.addFuel(usd); },
      settle: async (ms: number) => { T += ms; a.advance(0); },
      setPrice: (m: Market, p: number) => a.setPrice(m, p),
      dispose: () => a.dispose(),
    },
  };
}

runAdapterContract("stand-in (Nova-shaped params)", () => standIn().harness);
runAdapterContract("stand-in on ETH at 1000×", () => standIn().harness, { market: "ETH", collateralUsd: 5, leverage: 1000 });

const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof TurboError ? e.code : String(e); } };

test("Nova params: cost per side = fee + half spread + impact for the size", () => {
  const p = { ...STAND_IN_PARAMS.BTC, feeBps: 1, spreadBps: 2, impactBpsPer100k: 0.5 };
  assert.equal(sideCostBps(p, 0), 2);
  assert.equal(sideCostBps(p, 200_000), 3);
  assert.equal(minFuelAt(STAND_IN_PARAMS.BTC, 100), 5);
  assert.equal(minFuelAt(STAND_IN_PARAMS.BTC, 1000), 0.5);
  const { a } = standIn();
  const q = a.quote({ market: "BTC", side: "long", collateralUsd: 10, leverage: 1000 });
  // $10k notional: 1 bp + 0.2 × 0.1 bp = 1.02 bp a side
  assert.ok(Math.abs(q.openFeeUsd - 10_000 * 1.02e-4) < 1e-9, String(q.openFeeUsd));
  a.dispose();
});

test("Nova params: open interest cap refuses as market-full", async () => {
  const { a } = standIn({ params: { BTC: { ...STAND_IN_PARAMS.BTC, oiCapUsd: 15_000 }, ETH: STAND_IN_PARAMS.ETH } });
  await a.addFuel(100);
  assert.equal(await code(a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 1000 })), "ok");
  assert.equal(await code(a.open({ market: "BTC", side: "short", collateralUsd: 10, leverage: 1000 })), "market-full");
  assert.equal(a.getMarkets().find((m) => m.market === "BTC")!.openInterestUsd, 10_000);
  a.dispose();
});

test("Nova params: an order nobody answers is claimed back after about 50 s, fuel returned", async () => {
  const { a, clock } = standIn({ params: { BTC: { ...STAND_IN_PARAMS.BTC, fillMs: 120_000 }, ETH: STAND_IN_PARAMS.ETH } });
  const ev: TurboEvent[] = []; a.onEvent((e) => ev.push(e));
  await a.addFuel(20);
  await a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 100 });
  assert.equal((await a.getFuel()).usd, 10);
  clock(49_000);
  assert.equal(ev.at(-1)!.type, "pending");
  clock(1_500);
  assert.equal(ev.at(-1)!.type, "failed");
  assert.equal(ev.at(-1)!.reason, "timeout");
  assert.equal((await a.getFuel()).usd, 20, "all fuel back, no fees");
  assert.equal((await a.getPositions()).length, 0);
  a.dispose();
});

test("Nova params: borrowing is charged on top of funding while a run is open", async () => {
  const { a, clock } = standIn({ params: { BTC: { ...STAND_IN_PARAMS.BTC, fundingRatePerHour: 0, borrowRatePerHour: 0.0001 }, ETH: STAND_IN_PARAMS.ETH } });
  await a.addFuel(20);
  await a.open({ market: "BTC", side: "short", collateralUsd: 10, leverage: 100 });
  clock(2_000); // filled
  clock(3_600_000);
  const p = (await a.getPositions())[0];
  assert.ok(Math.abs(p.fundingUsd - -0.1) < 1e-3, `paid ≈ $0.10 on $1k for an hour, got ${p.fundingUsd}`);
  a.dispose();
});

test("stale price: with a live feed, an order after 15 s of silence is refused, then allowed when ticks return", async () => {
  let T = 1_000_000; let push: (m: Market, p: number) => void = () => {};
  const a = createMockAdapter({ now: () => T, fuel: createFuelStore({ storage: null, initialUsd: 50 }), params: STAND_IN_PARAMS,
    priceFeed: { start(cb) { push = cb; return () => {}; } } });
  const off = a.subscribePrice("BTC", () => {});
  push("BTC", 100_000);
  T += 16_000;
  assert.equal(await code(a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 100 })), "stale-price");
  push("BTC", 100_010);
  assert.equal(await code(a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 100 })), "ok");
  off(); a.dispose();
});

/**
 * Adapter contract: the behaviour Turbo's screen relies on, as a test suite any TurboAdapter must pass.
 *
 * The stand-in runs it on every `npm run test:turbo` (scripts/test-turbo-contract.mts). Nova's adapter runs the same
 * suite against staging by giving a harness that funds a test wallet and waits for real fills, so "it works in the
 * sample" and "it works on Nova" mean the same thing.
 *
 * Tests that need to move the price (liquidation) run only when the harness gives setPrice; on staging they are skipped.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Market, TurboAdapter, TurboEvent, TurboEventType } from "./types";
import { TurboError } from "./types";

export interface ContractHarness {
  adapter: TurboAdapter;
  /** Put $ into Turbo fuel. Stand-in: addFuel. Staging: a test faucet or a funded wallet. */
  fund(usd: number): Promise<void>;
  /** Let time pass so pending orders fill (stand-in: advance a fake clock; staging: wait real ms). */
  settle(ms: number): Promise<void>;
  /** Move the mark price. Stand-in only; leave out on staging. */
  setPrice?(m: Market, price: number): void;
  /** Called after each test. */
  dispose?(): void;
}

export interface ContractOptions {
  market?: Market;
  /** Fuel ($) and leverage for a normal run. Must clear the market's minimum position. */
  collateralUsd?: number;
  leverage?: number;
  /** Longest a fill may take (ms). */
  fillWithinMs?: number;
}

const TERMINAL: TurboEventType[] = ["closed", "liquidated", "failed"];

export function runAdapterContract(name: string, make: () => Promise<ContractHarness> | ContractHarness, o: ContractOptions = {}) {
  const market = o.market ?? "BTC";
  const C = o.collateralUsd ?? 10;
  const L = o.leverage ?? 100;
  const fillWithin = o.fillWithinMs ?? 10_000;

  const withHarness = (fn: (h: ContractHarness, events: TurboEvent[]) => Promise<void>) => async () => {
    const h = await make();
    const events: TurboEvent[] = [];
    const off = h.adapter.onEvent((e) => events.push(e));
    try { await fn(h, events); } finally { off(); h.dispose?.(); }
  };

  const openFilled = async (h: ContractHarness, events: TurboEvent[], side: "long" | "short" = "long") => {
    const { id } = await h.adapter.open({ market, side, collateralUsd: C, leverage: L });
    await h.settle(fillWithin);
    const filled = events.find((e) => e.position.id === id && e.type === "filled");
    assert.ok(filled, `order ${id} should fill within ${fillWithin} ms`);
    return id;
  };

  describe(`adapter contract: ${name}`, () => {
    test("markets: BTC and ETH, a leverage range, and full params when given", withHarness(async (h) => {
      const ms = h.adapter.getMarkets?.() ?? [];
      for (const m of ["BTC", "ETH"] as const) {
        const info = ms.find((x) => x.market === m);
        assert.ok(info, `${m} listed`);
        assert.ok(info!.maxLeverage >= (info!.minLeverage ?? 1), "max ≥ min leverage");
        if (info!.params) {
          const p = info!.params;
          assert.ok(p.feeBps >= 0 && p.spreadBps >= 0 && p.impactBpsPer100k >= 0, "costs are not negative");
          assert.ok(p.liqThreshold > 0 && p.liqThreshold <= 1, "threshold is a share of collateral");
          assert.ok(p.minPositionUsd >= 0 && p.oiCapUsd > 0, "min position and OI cap");
        }
      }
    }));

    test("price: a subscriber gets the latest tick right away, and unsubscribe stops it", withHarness(async (h) => {
      const ticks: number[] = [];
      const off = h.adapter.subscribePrice(market, (t) => { assert.ok(t.price > 0 && Number.isFinite(t.ts)); ticks.push(t.price); });
      assert.ok(ticks.length >= 1, "latest tick delivered on subscribe");
      off();
      const n = ticks.length;
      h.setPrice?.(market, ticks[0] * 1.001);
      assert.equal(ticks.length, n, "no ticks after unsubscribe");
    }));

    test("quote: size = fuel × leverage, liquidation on the losing side, fees not negative", withHarness(async (h) => {
      for (const side of ["long", "short"] as const) {
        const q = h.adapter.quote({ market, side, collateralUsd: C, leverage: L });
        assert.ok(Math.abs(q.sizeUsd - C * L) < 1e-6);
        assert.ok(q.openFeeUsd >= 0 && q.closeFeeUsd >= 0);
        if (side === "long") assert.ok(q.liqPrice < q.entryEst); else assert.ok(q.liqPrice > q.entryEst);
        // the H-BOMB line is near: at L× the distance is under 1/L of the price
        assert.ok(Math.abs(q.entryEst - q.liqPrice) / q.entryEst < 1 / L + 1e-9);
      }
    }));

    test("refusals throw TurboError with a code the screen can show", withHarness(async (h) => {
      const code = async (p: Parameters<TurboAdapter["open"]>[0]) => {
        try { await h.adapter.open(p); } catch (e) { assert.ok(e instanceof TurboError, `TurboError, got ${String(e)}`); return (e as TurboError).code; }
        return "opened";
      };
      assert.equal(await code({ market, side: "long", collateralUsd: C, leverage: L }), "no-fuel", "no fuel yet");
      await h.fund(C * 3);
      assert.equal(await code({ market, side: "long", collateralUsd: 0, leverage: L }), "bad-amount");
      assert.equal(await code({ market, side: "long", collateralUsd: C, leverage: 1e9 }), "leverage");
      const info = h.adapter.getMarkets?.().find((x) => x.market === market);
      if (info?.params && info.params.minPositionUsd > 0) {
        const lev = info.minLeverage ?? L;
        const tiny = (info.params.minPositionUsd / lev) * 0.5;
        assert.equal(await code({ market, side: "long", collateralUsd: tiny, leverage: lev }), "min-size");
      }
      assert.equal((await h.adapter.getPositions()).length, 0, "a refused order leaves nothing behind");
    }));

    test("open: id right away, pending then filled, fuel moves into the position", withHarness(async (h, events) => {
      await h.fund(C * 2);
      const before = (await h.adapter.getFuel()).usd;
      const { id } = await h.adapter.open({ market, side: "long", collateralUsd: C, leverage: L });
      assert.ok(typeof id === "string" && id.length > 0);
      assert.equal(events[0]?.type, "pending");
      assert.ok(Math.abs((await h.adapter.getFuel()).usd - (before - C)) < 1e-6, "collateral leaves fuel at send");
      await h.settle(fillWithin);
      const types = events.filter((e) => e.position.id === id).map((e) => e.type);
      assert.deepEqual(types.slice(0, 2), ["pending", "filled"]);
      const p = (await h.adapter.getPositions()).find((x) => x.id === id)!;
      assert.equal(p.status, "open");
      assert.ok(p.entry > 0 && Math.abs(p.sizeUsd - C * L) < 1e-6);
    }));

    test("close: 50% is a partial close, 100% closes, fuel comes back, nothing after the end", withHarness(async (h, events) => {
      await h.fund(C * 2);
      const id = await openFilled(h, events);
      const f0 = (await h.adapter.getFuel()).usd;
      await h.adapter.close(id, 50);
      const part = events.find((e) => e.position.id === id && e.type === "partial-closed");
      assert.ok(part && (part.returnedUsd ?? 0) >= 0 && part.pct === 50);
      await h.adapter.close(id, 100);
      const end = events.find((e) => e.position.id === id && e.type === "closed");
      assert.ok(end && (end.returnedUsd ?? 0) >= 0);
      const f1 = (await h.adapter.getFuel()).usd;
      assert.ok(Math.abs(f1 - (f0 + (part!.returnedUsd ?? 0) + (end!.returnedUsd ?? 0))) < 0.011, "fuel = returned $ (to the cent)");
      assert.equal((await h.adapter.getPositions()).some((x) => x.id === id), false, "closed position is gone");
      const last = events.filter((e) => e.position.id === id).at(-1)!;
      assert.ok(TERMINAL.includes(last.type), "terminal event is last");
    }));

    test("add (optional): more fuel at the same leverage, size grows, fuel leaves", withHarness(async (h, events) => {
      if (!h.adapter.increase) return;
      await h.fund(C * 3);
      const id = await openFilled(h, events);
      const f0 = (await h.adapter.getFuel()).usd;
      await h.adapter.increase(id, C);
      await h.settle(fillWithin);
      const inc = events.find((e) => e.position.id === id && e.type === "increased");
      assert.ok(inc && inc.addedUsd === C, "increased event with the fuel added");
      const p = (await h.adapter.getPositions()).find((x) => x.id === id)!;
      assert.ok(Math.abs(p.sizeUsd - 2 * C * L) < 1e-6 && Math.abs(p.collateralUsd - 2 * C) < 1e-6);
      assert.ok(Math.abs((await h.adapter.getFuel()).usd - (f0 - C)) < 0.011);
      await h.adapter.close(id, 100);
    }));

    test("liquidation: price through the line liquidates with $0 back", withHarness(async (h, events) => {
      if (!h.setPrice) return; // staging can't move the price
      await h.fund(C * 2);
      const id = await openFilled(h, events, "long");
      const p = (await h.adapter.getPositions()).find((x) => x.id === id)!;
      h.setPrice(market, p.liqPrice * 0.999);
      await h.settle(0);
      const liq = events.find((e) => e.position.id === id && e.type === "liquidated");
      assert.ok(liq, "liquidated");
      assert.equal(liq!.returnedUsd ?? 0, 0);
      assert.equal(events.filter((e) => e.position.id === id).at(-1)!.type, "liquidated");
    }));
  });
}

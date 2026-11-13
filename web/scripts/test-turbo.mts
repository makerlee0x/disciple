// Unit tests for TURBO math, the stand-in adapter, the price feed parser, flight mapping and prefs (lib/turbo).  npm run test:turbo
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSlice, feeUsd, fundingDeltaUsd, isLiquidated, liquidationPrice, pnlBreakdown, pricePnlUsd } from "../lib/turbo/math";
import { createFuelStore } from "../lib/turbo/fuel";
import { createMockAdapter } from "../lib/turbo/mockAdapter";
import { getTurboAdapter, isTurboEnabled, resetTurboAdapter } from "../lib/turbo/index";
import type { TurboEvent } from "../lib/turbo/types";
import { parseAllMids, parseAllMidsMessage, parseTradesMessage, createHyperliquidStream } from "../lib/turbo/priceFeed";
import { dangerLevel, dangerOf, isBigWin, jetstreamL, marketCapUsd, CIRCULATING } from "../lib/turbo/flight";
import { DEFAULT_PREFS, FUEL_PRESETS, LEVERAGE_PRESETS, fuelOf, leverageOf, loadPrefs, savePrefs } from "../lib/turbo/prefs";
import { TURBO_COPY } from "../lib/turbo/copy";

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

test("PnL after fees (display) = pnl − open fee + funding; close fee is estimated separately", () => {
  const b = pnlBreakdown({ side: "long", sizeUsd: 10_000, entry: 100, price: 101, openFeeUsd: 5, fundingUsd: -0.5, feeBps: 5 });
  near(b.pnlUsd, 100);
  near(b.closeFeeUsdEst, 5.05); // close fee on notional at 101, shown as its own row
  near(b.pnlAfterFeesUsd, 100 - 5 - 0.5);
});

test("liquidation price includes fees: value at liq == (1 − k)·C", () => {
  for (const side of ["long", "short"] as const) {
    for (const [C, L, bps, fund] of [[10, 1000, 1, 0], [10, 500, 5, 0.3], [100, 100, 4, -1], [25, 25, 5, 0]] as const) {
      const N = C * L, open = feeUsd(N, bps), k = 0.8;
      const liq = liquidationPrice({ side, collateralUsd: C, sizeUsd: N, entry: 100, openFeeUsd: open, fundingUsd: fund, feeBps: bps, liqLossFrac: k });
      const b = pnlBreakdown({ side, sizeUsd: N, entry: 100, price: liq, openFeeUsd: open, fundingUsd: fund, feeBps: bps });
      // Liq formula still includes the close fee; do not use display pnlAfterFeesUsd here.
      const realizedAtLiq = b.pnlUsd - open - b.closeFeeUsdEst + fund;
      near(C + realizedAtLiq, (1 - k) * C, 1e-6);
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
  const pending = (await a.getPositions())[0];
  assert.equal(pending.status, "pending");
  near(pending.pnlAfterFeesUsd, -q.openFeeUsd);
  tick(2000);
  assert.equal(events[1].type, "filled");
  const p = (await a.getPositions())[0];
  assert.equal(p.id, id); assert.equal(p.status, "open"); near(p.liqPrice, q.liqPrice); near(p.pnlAfterFeesUsd, -0.5);
});

test("open validation: leverage cap, fuel", async () => {
  const { a } = setup();
  await a.addFuel(10);
  await assert.rejects(a.open({ market: "BTC", side: "long", collateralUsd: 20, leverage: 10 }), /fuel/);
  await assert.rejects(a.open({ market: "BTC", side: "long", collateralUsd: 5, leverage: 1001 }));
  // High leverage that would be immediately underwater on fees is allowed to open (and may liquidate after fill).
  const { id } = await a.open({ market: "BTC", side: "long", collateralUsd: 5, leverage: 1000 });
  assert.ok(id);
  assert.equal((await a.getFuel()).usd, 5);
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

test("market only: no take-profit / stop-loss / limit API on the adapter", () => {
  const { a } = setup();
  assert.equal((a as unknown as Record<string, unknown>).setTpSl, undefined);
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

test("getTurboAdapter returns the stand-in (kind practice) with 1000× on both markets; flag is off by default on the server", () => {
  resetTurboAdapter();
  const a = getTurboAdapter();
  assert.equal(a.kind, "practice");
  assert.ok(a.getMarkets!().every((m) => m.standIn && m.maxLeverage === 1000));
  assert.deepEqual(a.depositInfo!(), { token: "USDC", network: "Arbitrum", address: null });
  assert.deepEqual(a.getMarkets!().map((m) => m.market), ["BTC", "ETH"]);
  assert.equal(isTurboEnabled(), process.env.NEXT_PUBLIC_TURBO === "1");
});

test("price feed: with a feed and no price yet, quote is NaN and open refuses; the first feed tick prices it", async () => {
  let push: ((m: "BTC" | "ETH", p: number) => void) | null = null;
  const a = createMockAdapter({ autoStart: false, fuel: createFuelStore({ storage: null }), priceFeed: { start(cb) { push = cb; return () => {}; } } });
  await a.addFuel(10);
  assert.ok(Number.isNaN(a.quote({ market: "BTC", side: "long", collateralUsd: 10, leverage: 100 }).entryEst));
  await assert.rejects(a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 100 }), /waiting on a price/);
  let got: number | null = null;
  const off = a.subscribePrice("BTC", (t) => { got = t.price; });
  assert.equal(got, null, "no made-up first tick");
  // autoStart false: start the feed by hand the way startTimer would
  a.setPrice("BTC", 70_000);
  assert.equal(got, 70_000);
  off(); a.dispose(); void push;
});

test("parseAllMids keeps BTC / ETH only and drops junk", () => {
  assert.deepEqual(parseAllMids({ BTC: "nope", ETH: -1 }), {});
  assert.deepEqual(parseAllMids(null), {});
});

test("flight height is BTC/ETH market cap, not PnL; liq line uses the cap at the liquidation price", () => {
  near(marketCapUsd("BTC", 100_000), 100_000 * CIRCULATING.BTC);
  near(marketCapUsd("ETH", 3_000), 3_000 * CIRCULATING.ETH);
  assert.ok(!(marketCapUsd("BTC", 0) > 0));
  const mid = 100_000, liq = 99_400;
  const rocket = marketCapUsd("BTC", mid), line = marketCapUsd("BTC", liq);
  assert.ok(line < rocket, "a long's liquidation cap sits below the live cap — the sky is not flipped");
  const shortLiq = marketCapUsd("BTC", 100_600);
  assert.ok(shortLiq > rocket, "a short's liquidation cap sits above the live cap");
});

test("price feed parses HTTP allMids and the WebSocket allMids / trades envelopes", () => {
  assert.deepEqual(parseAllMids({ BTC: "71382.5", ETH: "1998.55", HYPE: "40" }), { BTC: 71382.5, ETH: 1998.55 });
  assert.deepEqual(parseAllMidsMessage({ channel: "allMids", data: { mids: { BTC: "97000.25", ETH: "3300.5" } } }), { BTC: 97000.25, ETH: 3300.5 });
  const trades = parseTradesMessage({ channel: "trades", data: [
    { coin: "BTC", side: "B", px: "97000", sz: "0.5", time: 1, tid: 11 },
    { coin: "ETH", side: "A", px: "3300", sz: "2", time: 2, hash: "0xabc" },
    { coin: "SOL", side: "B", px: "200", sz: "1", time: 3 },
  ] });
  assert.equal(trades.length, 2);
  assert.equal(trades[0].market, "BTC"); assert.equal(trades[0].side, "buy"); near(trades[0].usd, 48500);
  assert.equal(trades[1].market, "ETH"); assert.equal(trades[1].side, "sell"); near(trades[1].usd, 6600);
  // Existing bomb ladder is price-impact % (puff < 2%, grenade ≥ 2%). A typical BTC print vs ~$2T cap is a puff.
  // Do not invent a new size ladder for Turbo (lee, Nov 12 10:42 AM CT).
  const cap = marketCapUsd("BTC", 100_000);
  const impactPct = (50_000 / (cap * 0.25)) * 100;
  assert.ok(impactPct < 2, "a $50k BTC print is far below the grenade threshold on actual BTC cap");
});

test("danger: share of the way from entry to liquidation; 50 / 80 / 95 levels", () => {
  const p = { side: "long" as const, entry: 100, liqPrice: 90 };
  near(dangerOf({ ...p, markPrice: 100 }), 0);
  near(dangerOf({ ...p, markPrice: 105 }), 0);
  near(dangerOf({ ...p, markPrice: 95 }), 0.5);
  assert.equal(dangerLevel(0.49), "calm"); assert.equal(dangerLevel(0.5), "hot"); assert.equal(dangerLevel(0.8), "shudder"); assert.equal(dangerLevel(0.95), "blow");
  near(dangerOf({ side: "short", entry: 100, liqPrice: 110, markPrice: 108 }), 0.8);
});

test("jetstream L = log10(lev)/3", () => {
  near(jetstreamL(10), 1 / 3); near(jetstreamL(100), 2 / 3); near(jetstreamL(1000), 1); near(jetstreamL(5000), 1);
});

test("big win share card: any profit after fees", () => {
  assert.ok(isBigWin(10)); assert.ok(isBigWin(100)); assert.ok(isBigWin(5)); assert.ok(isBigWin(0.01));
  assert.ok(!isBigWin(0)); assert.ok(!isBigWin(-5));
});

test("Hyperliquid stream subscribes to allMids + trades, never l2Book, and dispatches ticks and prints", async () => {
  const sent: string[] = [];
  type Sock = FakeWS;
  let opened: Sock | null = null;
  class FakeWS {
    readyState = 0;
    onopen: null | (() => void) = null;
    onmessage: null | ((e: { data: string }) => void) = null;
    onclose: null | (() => void) = null;
    onerror: null | (() => void) = null;
    constructor(_url: string) { opened = this; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(s: string) { sent.push(s); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const prices: Array<[string, number]> = [];
  const sides: string[] = [];
  const stream = createHyperliquidStream({ WebSocketImpl: FakeWS as unknown as typeof WebSocket, pollIntervalMs: 60_000 });
  const off = stream.start({ onPrice: (m, p) => prices.push([m, p]), onTrade: (t) => sides.push(`${t.market}:${t.side}`) });
  await new Promise((r) => setTimeout(r, 20));
  const payload = sent.join(" ");
  assert.ok(payload.includes("allMids"), "subscribes to allMids");
  assert.ok(payload.includes("trades") && payload.includes("BTC") && payload.includes("ETH"), "subscribes to BTC and ETH trades");
  assert.ok(!payload.includes("l2Book"), "does not subscribe to the order book");
  assert.ok(opened);
  opened!.onmessage?.({ data: JSON.stringify({ channel: "allMids", data: { mids: { BTC: "101000.5", ETH: "3500" } } }) });
  opened!.onmessage?.({ data: JSON.stringify({ channel: "trades", data: [{ coin: "BTC", side: "B", px: "101000.5", sz: "0.01", time: 9, tid: 1 }] }) });
  assert.deepEqual(prices, [["BTC", 101000.5], ["ETH", 3500]]);
  assert.deepEqual(sides, ["BTC:buy"]);
  off();
});

test("prefs: presets are 100/250/500/1000× and $10/$25/$50/$100; default 100× and $10; custom wins", () => {
  assert.deepEqual([...LEVERAGE_PRESETS], [100, 250, 500, 1000]);
  assert.deepEqual([...FUEL_PRESETS], [10, 25, 50, 100]);
  assert.equal(leverageOf(DEFAULT_PREFS), 100); assert.equal(fuelOf(DEFAULT_PREFS), 10);
  assert.equal(leverageOf({ ...DEFAULT_PREFS, levIdx: -1, levCustom: 333 }), 333);
  assert.equal(fuelOf({ ...DEFAULT_PREFS, fuelIdx: -1, fuelCustom: 7.5 }), 7.5);
  const mem = new Map<string, string>();
  const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) } as unknown as Storage;
  savePrefs({ market: "ETH", fuelIdx: 2, fuelCustom: 0, levIdx: 3, levCustom: 0 }, st);
  assert.deepEqual(loadPrefs(st), { market: "ETH", fuelIdx: 2, fuelCustom: 0, levIdx: 3, levCustom: 0 });
});

test("copy: no practice / test / real-money / take-profit / stop-loss / limit wording", () => {
  const all = JSON.stringify(TURBO_COPY, (_k, v) => (typeof v === "function" ? v(1, "$1", "BTC", "BOOST") : v)).toLowerCase();
  for (const bad of ["practice", "test version", "real money", "take profit", "take-profit", "stop loss", "stop-loss", "limit order", "lose all"]) assert.ok(!all.includes(bad), bad);
});

/* ---- v2: run-zoomed sky, run numbers, run log (Nov 13 2026) ---- */
import { breakEvenPrice, cashOutNowUsd, liqDistance, paceLabel, skyOffsetPx, SKY_LIQ_FRAC, typicalRunSeconds } from "../lib/turbo/flight";
import { bestToday, clock, createRunStore, longestAt, multipleLabel, streak, type TurboRun } from "../lib/turbo/runs";
import { RUN_COPY } from "../lib/turbo/copy";

test("sky: the H-BOMB line sits SKY_LIQ_FRAC of the screen below boarding at every gear", () => {
  for (const lv of LEVERAGE_PRESETS) {
    const a = createMockAdapter({ autoStart: false, startPrices: { BTC: 97_250 } }); a.setPrice("BTC", 97_250);
    const q = a.quote({ market: "BTC", side: "long", collateralUsd: 10, leverage: lv });
    const d = liqDistance(q.entryEst, q.liqPrice);
    near(skyOffsetPx(q.liqPrice, q.entryEst, d, 900), -SKY_LIQ_FRAC * 900, 1e-6);
    near(skyOffsetPx(q.entryEst, q.entryEst, d, 900), 0);
    a.dispose();
  }
});

test("break-even covers both fees; cashing out at break-even returns the fuel", () => {
  const a = createMockAdapter({ autoStart: false, startPrices: { BTC: 100_000 }, fillDelayMs: 0 }); a.setPrice("BTC", 100_000);
  return a.addFuel(100).then(() => a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 1000 })).then(async () => {
    a.flushFills();
    let [p] = await a.getPositions();
    const be = breakEvenPrice(p);
    assert.ok(be > p.entry);
    a.setPrice("BTC", be);
    [p] = await a.getPositions();
    near(cashOutNowUsd(p), 10, 0.02);
    a.dispose();
  });
});

test("gear pace labels: higher gear, faster run", () => {
  const secs = [0.0078, 0.003, 0.0014, 0.0006].map((d) => typicalRunSeconds("BTC", d));
  for (let i = 1; i < secs.length; i++) assert.ok(secs[i] < secs[i - 1]);
  assert.deepEqual(secs.map(paceLabel), ["~2 hr", "~20 min", "~5 min", "~1 min"]);
});

test("run log: streak, best today, longest at a gear, labels", () => {
  const mem = new Map<string, string>();
  const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } } as unknown as Storage;
  const runs = createRunStore(st);
  const t = Date.now();
  const r = (id: string, mult: number, lev: number, ms: number): TurboRun => ({ id, kind: mult > 0 ? "cashed" : "hbomb", market: "BTC", side: "long", leverage: lev, fuelUsd: 10, backUsd: 10 * mult, multiple: mult, startedAt: t - ms, endedAt: t });
  runs.add(r("a", 2, 1000, 30_000)); runs.add(r("b", 0, 1000, 72_000)); runs.add(r("c", 1.4, 500, 10_000)); runs.add(r("d", 3.1, 1000, 52_000));
  const all = runs.all();
  assert.equal(streak(all), 2);
  near(bestToday(all, t)!, 3.1);
  assert.equal(longestAt(all, 1000), 72_000);
  assert.equal(clock(41_000), "0:41"); assert.equal(clock(72_000), "1:12"); assert.equal(clock(7_390_000), "2:03:10");
  assert.equal(multipleLabel(3.1), "3.1×"); assert.equal(multipleLabel(0.24), "0.24×"); assert.equal(multipleLabel(1.42), "1.42×");
});

test("run copy keeps the same rules", () => {
  const all = JSON.stringify(RUN_COPY, (_k, v) => (typeof v === "function" ? v("$1", "$1", "1:00", "BOOST", "BTC", "0:41") : v)).toLowerCase();
  for (const bad of ["practice", "test version", "real money", "take profit", "stop loss", "limit order", "win it back", "double"]) assert.ok(!all.includes(bad), bad);
});

// ---- v2.1: 2× line, routes ----
import { multiplePrice } from "../lib/turbo/flight";
import { ROUTES } from "../lib/turbo/routes";

test("v2.1 multiplePrice: the 2× line sits where the run pays back twice the fuel", () => {
  const base = { entry: 100_000, sizeUsd: 10_000, markPrice: 100_000, collateralUsd: 10, pnlAfterFeesUsd: -1, closeFeeUsdEst: 1 };
  const long = multiplePrice({ side: "long", ...base }, 10, 0, 2);
  // cash now = 8, need 12 more on $10k size = +0.12% of entry
  assert.ok(Math.abs(long - 100_120) < 1e-6, String(long));
  const short = multiplePrice({ side: "short", ...base }, 10, 0, 2);
  assert.ok(Math.abs(short - 99_880) < 1e-6, String(short));
  // banked $5 already: only $7 more needed
  assert.ok(Math.abs(multiplePrice({ side: "long", ...base }, 10, 5, 2) - 100_070) < 1e-6);
  assert.equal(multiplePrice({ side: "long", ...base, sizeUsd: 0 }, 10, 0), 0);
});

test("v2.1 routes: BTC and ETH each have their own pad, sky key and accent", () => {
  assert.notEqual(ROUTES.BTC.key, ROUTES.ETH.key);
  assert.notEqual(ROUTES.BTC.pad, ROUTES.ETH.pad);
  assert.notEqual(ROUTES.BTC.vars["--r-acc"], ROUTES.ETH.vars["--r-acc"]);
  const copy = JSON.stringify(ROUTES).toLowerCase();
  for (const bad of ["practice", "testnet", "coming soon", "stop-loss", "take profit"]) assert.ok(!copy.includes(bad), bad);
});

// Zero-wait taps (job 9, lee Oct 30 "Get rid of the delay entirely"): quote model, cache peek/staleness, sell-all from
// the tracked balance, the bounded direct ∥ proxy race. Run: npx tsx --test scripts/test-zero-wait.mts
import test from "node:test";
import assert from "node:assert/strict";
import { QuoteModel, depthOf } from "../lib/trade/quoteModel";
import { TtlCache, OPPOSITE_WAIT, OPPOSITE_WAIT_MS, firstOk } from "../lib/trade/hotCache";
import { raceRequest, withinBudget, ReadBudgetError, RouteState } from "../lib/rpc/readTransport";
import { tapSellBalance, sellAmountFor } from "../lib/flight/liveSell";
import { tradeMinOut } from "../lib/trade/queuePricing";

const B = BigInt, E18 = B(10) ** B(18), E6 = B(10) ** B(6);
// constant-product pool: x USDG, y tokens, 1 % fee on input
const pool = (x: bigint, y: bigint) => ({
  x, y,
  buy(a: bigint) { const ai = (a * B(99)) / B(100); return (this.y * ai) / (this.x + ai); },
  sell(t: bigint) { const ti = (t * B(99)) / B(100); return (this.x * ti) / (this.y + ti); },
  doBuy(a: bigint) { const o = this.buy(a); this.x += a; this.y -= o; return o; },
  doSell(t: bigint) { const o = this.sell(t); this.y += t; this.x -= o; return o; },
});
const relErr = (a: bigint, b: bigint) => Math.abs(Number(a - b)) / Number(b);

test("depth fit recovers a constant-product pool", () => {
  const p = pool(B(50_000) * E6, B(800_000_000) * E18);
  const a1 = B(10) * E6, a2 = B(20) * E6;
  const Bfit = depthOf(Number(a1), Number(p.buy(a1)), Number(a2), Number(p.buy(a2)))!;
  // B = x / (1 − fee) in input units
  assert.ok(Math.abs(Bfit - Number(p.x) / 0.99) / (Number(p.x) / 0.99) < 1e-6, `B ${Bfit}`);
  assert.equal(depthOf(1, 1, 1, 1), undefined);
  assert.equal(depthOf(1, 2, 2, 5), undefined, "convex ⇒ no fit");
});

test("model: cold ⇒ undefined; exact base; other amounts scaled along the fit", () => {
  let t = 1_000; const m = new QuoteModel(() => t);
  const p = pool(B(50_000) * E6, B(800_000_000) * E18), r = "usdg|tok";
  assert.equal(m.quote(r, "buy", B(10) * E6), undefined, "cold");
  m.observe(r, "buy", B(10) * E6, p.buy(B(10) * E6), t);
  const q1 = m.quote(r, "buy", B(10) * E6)!;
  assert.equal(q1.src, "exact"); assert.equal(q1.lo, p.buy(B(10) * E6)); assert.equal(q1.hi, q1.lo);
  assert.equal(m.quote(r, "buy", B(25) * E6), undefined, "no depth yet ⇒ only the exact amount");
  t += 500; m.observe(r, "buy", B(20) * E6, p.buy(B(20) * E6), t);
  const q2 = m.quote(r, "buy", B(37) * E6)!;
  assert.equal(q2.src, "model");
  assert.ok(relErr(q2.lo, p.buy(B(37) * E6)) < 1e-9, `scaled ${q2.lo} vs ${p.buy(B(37) * E6)}`);
  t += 30_000;
  assert.equal(m.quote(r, "buy", B(10) * E6)!.src, "model", "exact older than 15 s ⇒ the newest point, scaled");
  assert.ok(m.quote(r, "buy", B(10) * E6)!.ageMs >= 30_000, "age reported");
});

test("model: own in-flight trades (same + opposite side) ⇒ [lo, hi] covers every landing order", () => {
  let t = 1_000; const m = new QuoteModel(() => t);
  const p = pool(B(20_000) * E6, B(500_000_000) * E18), r = "usdg|tok";
  const A = B(25) * E6, T = B(2_000_000) * E18;
  m.observe(r, "buy", A, p.buy(A), t); m.observe(r, "buy", A * B(2), p.buy(A * B(2)), t);
  m.observe(r, "sell", T, p.sell(T), t); m.observe(r, "sell", T * B(2), p.sell(T * B(2)), t);
  t += 100;
  // a sell of T in flight, then a buy tap: buy lands first ⇒ p.buy(A); sell first ⇒ more tokens
  const sellOut = p.sell(T);
  const id = m.begin(r, "sell", T, sellOut);
  const q = m.quote(r, "buy", A)!;
  const after = pool(p.x, p.y); after.doSell(T);
  assert.ok(relErr(q.lo, p.buy(A)) < 1e-6, "lo = buy lands first");
  // fee-on-input pools: the model moves B by the fee-less amount ⇒ ~fee × impact error (here 4e-5)
  assert.ok(relErr(q.hi, after.buy(A)) < 2e-4, `hi = sell lands first ${q.hi} vs ${after.buy(A)}`);
  assert.equal(q.inflight, 1);
  // session window (15 % max) clears both orders
  const mo = tradeMinOut(q, 9999, 1500);
  assert.ok(mo <= q.lo && mo * B(10_000) >= q.hi * B(10_000 - 1500), "minOut inside the policy window for both orders");
  // the sell lands (receipt amounts); a quote read before it still applies it, definitely
  const real = p.doSell(T); t += 50; m.land(r, id, real, t);
  const q2 = m.quote(r, "buy", A)!;
  assert.ok(relErr(q2.lo, p.buy(A)) < 2e-4 && q2.lo === q2.hi, "landed ⇒ applied for sure (no range)");
  assert.equal(q2.landed, 1);
  // a read after the landing is the base; nothing applied
  t += 50; m.observe(r, "buy", A, p.buy(A), t);
  const q3 = m.quote(r, "buy", A)!;
  assert.equal(q3.src, "exact"); assert.equal(q3.lo, p.buy(A)); assert.equal(q3.landed + q3.inflight, 0);
  // a failed trade is forgotten
  const id2 = m.begin(r, "buy", A, p.buy(A)); m.end(r, id2);
  assert.equal(m.inflight(r), 0);
});

test("model: rapid same-side buys and a read that straddles a landing", () => {
  let t = 1_000; const m = new QuoteModel(() => t);
  const p = pool(B(20_000) * E6, B(500_000_000) * E18), r = "usdg|tok";
  const A = B(50) * E6;
  m.observe(r, "buy", A, p.buy(A), t); m.observe(r, "buy", A * B(3), p.buy(A * B(3)), t);
  const ids = [1, 2, 3].map(() => { const q = m.quote(r, "buy", A)!; return m.begin(r, "buy", A, (q.lo + q.hi) / B(2)); });
  const q4 = m.quote(r, "buy", A)!;
  const all = pool(p.x, p.y); all.doBuy(A); all.doBuy(A); all.doBuy(A);
  assert.ok(relErr(q4.hi, p.buy(A)) < 1e-6, "first to land");
  assert.ok(relErr(q4.lo, all.buy(A)) < 2e-3, `after all three ${q4.lo} vs ${all.buy(A)}`);
  // a read that started before a landing it may or may not have seen ⇒ that trade stays in the range
  const real = p.doBuy(A); t += 10; const readAt = t; t += 10; m.land(r, ids[0], real, t);
  m.observe(r, "buy", A, p.buy(A), readAt);   // the node had it (post-trade state), read started before the receipt
  const q5 = m.quote(r, "buy", A)!;
  assert.ok(q5.hi >= p.buy(A) - B(1), "the straddling trade is not double-applied in hi");
});

test("TtlCache.peek: any age, never reads", () => {
  let t = 0; const c = new TtlCache<number>(1000, () => t);
  assert.equal(c.peek("k"), undefined);
  c.set("k", 7); t = 60_000;
  assert.deepEqual(c.peek("k"), { v: 7, ageMs: 60_000 });
  assert.equal(c.fresh("k"), undefined, "fresh() still honours the TTL");
});

test("TtlCache own writes: a read that started before our receipt can't overwrite it", async () => {
  let t = 0; const c = new TtlCache<bigint>(5000, () => t);
  c.set("b", B(100));
  // a balance read starts, our sell lands and is booked (−40), then the old read answers 100
  let answer!: (v: bigint) => void;
  const p = c.get("b", () => new Promise<bigint>((r) => { answer = r; }), -1);
  t = 10; c.setOwn("b", B(60));
  t = 20; answer(B(100)); await p;
  assert.equal(c.peek("b")!.v, B(60), "pre-trade read dropped");
  // a read started after the booking is taken
  t = 30; await c.get("b", async () => B(55), -1);
  assert.equal(c.peek("b")!.v, B(55));
  assert.equal(c.setRead("b", B(1), 5), false);
});

test("opposite-side wait is off by default (#210's 3.5 s bound kept for A/B)", () => {
  assert.equal(OPPOSITE_WAIT.ms, 0);
  assert.equal(OPPOSITE_WAIT_MS, 3500);
});

test("sell-all / % sells from the tracked balance (router has no sell-all: exact tokensIn)", async () => {
  let reads = 0;
  const cold = async () => { reads++; return B(5) * E18; };
  assert.deepEqual(await tapSellBalance(B(3) * E18, cold), { bal: B(3) * E18, src: "tracked" });
  assert.equal(reads, 0, "tracked ⇒ no read");
  assert.deepEqual(await tapSellBalance(undefined, cold), { bal: B(5) * E18, src: "read" });
  assert.deepEqual(await tapSellBalance(B(0), cold), { bal: B(5) * E18, src: "read" }, "0 tracked ⇒ double-check");
  assert.deepEqual(await tapSellBalance(B(0), async () => { throw new Error("hung"); }), { bal: B(0), src: "tracked" });
  assert.equal(sellAmountFor(B(3) * E18 + B(7), { frac: 1 }), B(3) * E18 + B(7), "100 % = every wei");
  assert.equal(sellAmountFor(B(3) * E18 + B(7), { all: true }), B(3) * E18 + B(7));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hang: () => Promise<unknown> = () => new Promise(() => {});
const httpErr = (status: number) => Object.assign(new Error(`HTTP request failed. Status: ${status}`), { name: "HttpRequestError", status });
const revert = () => Object.assign(new Error("execution reverted"), { code: 3 });
test("race: direct hung ⇒ proxy answers; both hung ⇒ budget; revert ⇒ final; CORS 400 / 429 ⇒ the other path", async () => {
  const st = () => new RouteState();
  const mk = (direct: () => Promise<unknown>, proxy: (() => Promise<unknown>) | null, budgetMs = 300) =>
    raceRequest({ directUrl: "d", direct: () => direct(), proxy: proxy ? () => proxy() : null, budgetMs, state: st() });
  let t = Date.now();
  assert.equal(await mk(hang, async () => { await sleep(30); return "0x1"; })({ method: "eth_call" }), "0x1");
  assert.ok(Date.now() - t < 200, "proxy wins without waiting for the hung direct");
  t = Date.now();
  await assert.rejects(mk(hang, hang)({ method: "eth_call" }), (e: unknown) => e instanceof ReadBudgetError && (e as Error).name === "TimeoutError");
  assert.ok(Date.now() - t < 400, "bounded by the budget");
  t = Date.now();
  await assert.rejects(mk(async () => { throw revert(); }, hang)({ method: "eth_call" }), /reverted/);
  assert.ok(Date.now() - t < 100, "a node answer is final at once");
  assert.equal(await mk(async () => { throw httpErr(400); }, async () => "0x2")({ method: "eth_call" }), "0x2");
  assert.equal(await mk(async () => { throw httpErr(429); }, async () => "0x3")({ method: "eth_call" }), "0x3");
  assert.equal(await mk(async () => { await sleep(10); return "0xd"; }, async () => { await sleep(50); return "0xp"; })({ method: "eth_call" }), "0xd");
  await assert.rejects(mk(async () => { throw httpErr(400); }, async () => { throw httpErr(429); })({ method: "eth_call" }), /429|400/);
  // no proxy (node / non-read method): direct only, still bounded
  t = Date.now();
  await assert.rejects(mk(hang, null, 150)({ method: "eth_call" }), ReadBudgetError);
  assert.ok(Date.now() - t < 300);
});

test("withinBudget bounds a shared (possibly hung) read", async () => {
  const t = Date.now();
  await assert.rejects(withinBudget(new Promise(() => {}), 100, "x"), ReadBudgetError);
  assert.ok(Date.now() - t < 250);
  assert.equal(await withinBudget(Promise.resolve(5), 100, "x"), 5);
});

test("TtlCache.get race: a tap read doesn't just join a hung background read", async () => {
  const c = new TtlCache<number>(60_000);
  const hung = c.get("k", () => new Promise<number>(() => {}));   // background warm stuck on a hung RPC
  void hung;
  const t0 = Date.now();
  assert.equal(await c.get("k", async () => 7, undefined, true), 7);
  assert.ok(Date.now() - t0 < 50);
  assert.equal(c.fresh("k"), 7);
  // without race it joins (the old behaviour): still pending after 50 ms
  const c2 = new TtlCache<number>(60_000); void c2.get("k", () => new Promise<number>(() => {}));
  const joined = await Promise.race([c2.get("k", async () => 7), new Promise((r) => setTimeout(() => r("pending"), 50))]);
  assert.equal(joined, "pending");
  await assert.rejects(firstOk([Promise.reject(new Error("a")), Promise.reject(new Error("b"))]), /b/);
});

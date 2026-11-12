// lee, Oct 30: "Price moved past your one-tap max slippage" on buys after our own sells (and vice versa). Two causes:
//  (a) in-flight tracking was per side ⇒ a buy tapped while our sell was in flight was priced on the pre-sell pool;
//  (b) the session minOut sat at quote × (1 − max + 0.5%) ⇒ a move in the player's FAVOR ≥ ~0.5% failed MinOutTooLow.
// Fix: beginTap/waitOpposite (hotCache) + quoteRange + tradeMinOut/sessionWindowMinOut (centered policy window).
import { test } from "node:test";
import assert from "node:assert/strict";
import { beginTap, quoteRange, addInflight, OPPOSITE_WAIT_MS, key as ckey } from "../lib/trade/hotCache";
import { tradeMinOut, NO_REFUSE_SLIPPAGE_BPS } from "../lib/trade/queuePricing";
import { isqrt, sessionWindowMinOut, meetsPolicyFloor, clampSlippage } from "../lib/aa/slippage";
import { applySlippage } from "../lib/curveMath";

const B = BigInt, E18 = B(10) ** B(18);
const TK = "0x00000000000000000000000000000000000000c1";
/** both on-chain checks for a minOut against the live output at execution (policy re-quote = live) */
const passes = (minOut: bigint, live: bigint, maxBps: number) => ({ policy: meetsPolicyFloor(minOut, live, maxBps), router: live >= minOut });
const ok = (r: { policy: boolean; router: boolean }) => r.policy && r.router;
const at = (q: bigint, pct: number) => (q * B(Math.round((1 + pct / 100) * 1e6))) / B(1e6);   // q moved by pct %

test("isqrt is exact (floor) incl. huge values", () => {
  for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n, 10n ** 36n - 1n, (10n ** 30n + 7n) ** 2n, (10n ** 30n + 7n) ** 2n - 1n]) {
    const r = isqrt(n); assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, String(n));
  }
});

test("session window: favorable moves within the window pass; adverse within it pass; beyond the user's side fails", () => {
  const q = 1234n * E18;
  // [session bps, adverse tolerance %, favorable tolerance %] — 1 − √(1−M) and 1/√(1−M) − 1
  for (const [m, adv, fav] of [[500, 2.53, 2.60], [1500, 7.80, 8.47], [3000, 16.33, 19.52], [5000, 29.29, 41.42]] as const) {
    const mo = sessionWindowMinOut(q, q, m);
    const old = applySlippage(q, clampSlippage(NO_REFUSE_SLIPPAGE_BPS, m).bps!);   // main: session max − 0.5 %
    assert.ok(ok(passes(mo, q, m)), `${m}: at quote`);
    assert.ok(ok(passes(mo, at(q, fav - 0.02), m)), `${m}: +${fav}% favorable passes`);
    assert.ok(ok(passes(mo, at(q, -(adv - 0.02)), m)), `${m}: −${adv}% adverse passes`);
    assert.ok(!ok(passes(mo, at(q, -(adv + 0.05)), m)), `${m}: adverse beyond the window fails (router min-out)`);
    assert.equal(passes(mo, at(q, -(adv + 0.05)), m).router, false);
    // the old minOut failed the policy on any favorable move > 0.5 % / (1 − M) (the bug)
    assert.equal(passes(old, at(q, 2), m).policy, false, `${m}: old +2% → MinOutTooLow`);   // old favorable room: 0.5 % / (1 − M)
    assert.ok(ok(passes(mo, at(q, 2), m)), `${m}: new +2% passes`);
  }
  // fork repro (VFIVE, $100 buy after a $27 sell landed first): live/quoted 1.0175 ⇒ now passes at 5 % and 15 %
  assert.ok(ok(passes(sessionWindowMinOut(q, q, 500), at(q, 1.75), 500)));
  assert.ok(ok(passes(sessionWindowMinOut(q, q, 1500), at(q, 1.75), 1500)));
});

test("tradeMinOut: session ⇒ window (≥ policy-safe), tighter caller slippage wins, no session ⇒ unchanged", () => {
  const q = 1000n * E18, r = { lo: q, hi: q };
  const tb = clampSlippage(NO_REFUSE_SLIPPAGE_BPS, 1500).bps!;   // TradeBridge's request under a 15 % session
  assert.equal(tradeMinOut(r, tb, 1500), sessionWindowMinOut(q, q, 1500));
  assert.equal(tradeMinOut(r, 100, 1500), applySlippage(q, 100));               // explicit 1 % > window: kept
  assert.equal(tradeMinOut(r, NO_REFUSE_SLIPPAGE_BPS, null), applySlippage(q, NO_REFUSE_SLIPPAGE_BPS));   // no session
  assert.equal(tradeMinOut(r, undefined, null, 100), applySlippage(q, 100));
  // same-side burst: [lo, hi] = [marginal, plain] — both landing orders clear both checks when they fit the window
  const lo = 980n * E18, hi = 1000n * E18, mo = tradeMinOut({ lo, hi }, tb, 1500);
  assert.ok(ok(passes(mo, lo, 1500)) && ok(passes(mo, hi, 1500)));
  // range wider than the window: priced for the likelier order (earlier shot first ⇒ live = lo), never a dust floor
  const wl = 500n * E18, wmo = tradeMinOut({ lo: wl, hi }, tb, 1500);
  assert.equal(wmo, sessionWindowMinOut(wl, wl, 1500));
  assert.ok(ok(passes(wmo, wl, 1500)));
});

test("quoteRange: nothing in flight ⇒ one quote; in flight ⇒ [marginal, plain] from fresh reads", async () => {
  const curve = (a: bigint) => (a * 1000n) / (a + 1000n);   // concave stand-in: marginal < plain
  const calls: [bigint, number | undefined][] = [];
  const quote = async (a: bigint, age?: number) => { calls.push([a, age]); return curve(a); };
  const k = ckey("usdgroute", TK, "buy");
  assert.deepEqual(await quoteRange(k, 100n, quote), { lo: curve(100n), hi: curve(100n) });
  assert.equal(calls.length, 1);
  const done = addInflight(k, 300n); calls.length = 0;
  const r = await quoteRange(k, 100n, quote);
  assert.deepEqual(r, { lo: curve(400n) - curve(300n), hi: curve(100n) });
  assert.ok(calls.every(([, age]) => age === 0));
  done();
});

test("beginTap: a tap waits for EARLIER opposite-side taps only; same side stays parallel; bounded", async () => {
  const sell = beginTap(TK, "sell");
  const buy2 = beginTap(TK, "sell");
  assert.equal(buy2.opposite, 0, "same side: no wait");
  assert.deepEqual(await buy2.waitOpposite(), { waitedMs: 0, timedOut: false });
  const buy = beginTap(TK, "buy");
  assert.equal(buy.opposite, 2);
  let resolved = false;
  const w = buy.waitOpposite(2000).then((x) => { resolved = true; return x; });
  await new Promise((r) => setTimeout(r, 40)); assert.equal(resolved, false);
  sell.end(); await new Promise((r) => setTimeout(r, 10)); assert.equal(resolved, false, "still one sell in flight");
  buy2.end(); buy2.end();   // idempotent
  const got = await w; assert.equal(got.timedOut, false); assert.ok(got.waitedMs < 1000);
  // a sell tapped after the buy waits for the buy, never the other way round (no cycles)
  const sellAfter = beginTap(TK, "sell"); assert.equal(sellAfter.opposite, 1);
  const t = await sellAfter.waitOpposite(60); assert.equal(t.timedOut, true, "bounded: priced anyway after maxMs");
  buy.end(); sellAfter.end();
  assert.equal(beginTap(TK, "buy").opposite, 0, "list cleared");
  assert.ok(OPPOSITE_WAIT_MS > 0 && OPPOSITE_WAIT_MS <= 5000);
  // other coins never wait
  const s = beginTap(TK, "sell"); assert.equal(beginTap("0x00000000000000000000000000000000000000c2", "buy").opposite, 0); s.end();
});

// SITE pre-send alerts + no-refuse pricing (lee, Oct 26 10:50–10:52 CDT). npm run test:trade-guards
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAlert, walletCapAlert, impactAlert, buyFill, BUY_MAX_HEADROOM, COPY_PENDING_LEE } from "../lib/trade/tradeGuards";
import { noRefuseMinOut, holdInflightUntilSeen, sendWithRequote } from "../lib/trade/queuePricing";

// EASY coin: 1 B supply, mcap $5,000 ⇒ $0.000005 / coin; cap 1 % (100 bps) = 10 M coins ≈ $50
const easy = { capBps: 100, supply: 1e9, holding: 0, priceUsd: 5e-6 };
test("over-room buy is not held: it fills to the wallet limit (buyFill sends the room's $) with a plain note", () => {
  // the alert never holds an over-room buy any more (lee, Oct 31); only a full wallet holds
  assert.equal(walletCapAlert(80, easy), null);
  const f = buyFill(80, easy);
  assert.equal(f.capped, true);
  assert.ok(f.usd > 45 && f.usd < 50, String(f.usd));
  assert.equal(f.usd, Math.floor(1e7 * 5e-6 * BUY_MAX_HEADROOM * 100) / 100, "97 % of the room at the mark, floored to the cent");
  assert.equal(f.note, COPY_PENDING_LEE.walletFill("1%", f.usd));
  assert.match(f.note!, /^Wallet limit: this coin's mode caps each wallet at 1%\. Buying \$4\d\.\d\d to fill it; the rest stays in your cash\.$/);
  assert.doesNotMatch(f.note!, /revert|tx|0x|HTTP|relay|refund|graduat/i);
  assert.deepEqual(buyFill(f.usd, easy), { usd: f.usd, capped: false }, "the room itself is sent as typed");
});
// $24.30 of room: 97 % × room × mark = 24.30 ⇒ room = 24.30 / 0.97 / 5e-6 coins; holding = cap − room
const room2430 = { ...easy, holding: 1e7 - 24.30 / BUY_MAX_HEADROOM / 5e-6 + 1 };
test("$24.30 of room: $25 and $50 buys go through and send ~$24.30 (no hold); a $10 buy is unchanged", () => {
  for (const usd of [25, 50]) {
    assert.equal(nextAlert("buy", usd, { cap: room2430 }), null, `$${usd}: not held`);
    const f = buyFill(usd, room2430);
    assert.equal(f.capped, true);
    assert.ok(f.usd >= 24.29 && f.usd <= 24.30, `$${usd} ⇒ ${f.usd}`);
    assert.ok(f.usd / room2430.priceUsd <= (1e7 - room2430.holding) * BUY_MAX_HEADROOM + 1e-6, "coins at the mark stay under the on-chain room");
    assert.equal(f.note, `Wallet limit: this coin's mode caps each wallet at 1%. Buying ${"$" + f.usd.toFixed(2)} to fill it; the rest stays in your cash.`);
  }
  assert.deepEqual(buyFill(10, room2430), { usd: 10, capped: false });
  assert.equal(nextAlert("buy", 10, { cap: room2430 }), null);
});
test("holdings + pending buys count against the room; full wallet (room 0) ⇒ held, no Buy max, nothing sent", () => {
  assert.ok(buyFill(30, { ...easy, holding: 5e6 }).capped);
  const p = buyFill(30, { ...easy, holding: 2e6, pendingBuyTokens: 3e6 });
  assert.ok(p.capped && p.usd < 25, String(p.usd));
  for (const c of [{ ...easy, holding: 1e7 }, { ...easy, holding: 6e6, pendingBuyTokens: 4e6 }, { ...easy, holding: 2e7 }]) {
    const full = walletCapAlert(5, c)!;
    assert.equal(full.kind, "walletcap");
    assert.equal(full.maxUsd, 0); assert.equal(full.actionLabel, "");
    assert.equal(full.text, COPY_PENDING_LEE.walletFull("1%"));
    assert.equal(nextAlert("buy", 5, { cap: c })!.kind, "walletcap");
    assert.deepEqual(buyFill(5, c), { usd: 5, capped: false }, "buyFill never sizes a full wallet (the hold shows instead)");
  }
});
test("no cap (Trench / graduated) or unknown price ⇒ no wallet alert", () => {
  assert.equal(walletCapAlert(1e6, { ...easy, capBps: null }), null);
  assert.equal(walletCapAlert(1e6, { ...easy, priceUsd: 0 }), null);
  assert.deepEqual(buyFill(1e6, { ...easy, capBps: null }), { usd: 1e6, capped: false });
  assert.deepEqual(buyFill(1e6, { ...easy, priceUsd: 0 }), { usd: 1e6, capped: false });
  assert.deepEqual(buyFill(50, null), { usd: 50, capped: false });
});
test("> 10 % impact ⇒ warning (buy coins / sell $); ≤ 10 % or unknown ⇒ none", () => {
  assert.equal(impactAlert("sell", 1001, { usdOut: 12.345 })!.text, "High price impact: this sell moves the price over 10%. You'll get about $12.35.");
  assert.equal(impactAlert("buy", 2500, { coinsOut: 1_234_567 })!.text, "High price impact: this buy moves the price over 10%. You'll get about 1.23M coins.");
  assert.equal(impactAlert("sell", 1000, { usdOut: 1 }), null);
  assert.equal(impactAlert("buy", null, {}), null);
});
test("only a full wallet holds a trade; price impact never does (lee; GAME review #201)", () => {
  const i = { cap: { ...easy, holding: 1e7 } };
  assert.equal(nextAlert("buy", 80, { cap: easy }), null, "over-room: fills to the limit, not held");
  assert.equal(nextAlert("buy", 80, i)!.kind, "walletcap");
  assert.equal(nextAlert("buy", 80, i, ["walletcap"]), null);
  assert.equal(nextAlert("sell", 80, i), null, "sells: no wallet cap, and impact never holds");
  const w = impactAlert("buy", 3000, { coinsOut: 1e7 })!;
  assert.equal(w.kind, "impact");
  assert.ok(!("actionLabel" in w), "no Go ahead tap for impact");
});
test("noRefuseMinOut: never refuses on price (≥ 1 wei, 99.99 %)", () => {
  assert.equal(noRefuseMinOut(BigInt(1_000_000), null), BigInt(100));
  assert.equal(noRefuseMinOut(BigInt(1), null), BigInt(1));
});
test("holdInflightUntilSeen releases once the RPC head reaches the landed block", async () => {
  let head = BigInt(10), released = false;
  const p = holdInflightUntilSeen(() => { released = true; }, BigInt(12), async () => head++, { everyMs: 1, maxMs: 1000 });
  await p; assert.ok(released); assert.ok(head >= BigInt(12));
});
test("sendWithRequote: resends once on a definite revert, never on Timeout", async () => {
  let n = 0;
  const r = await sendWithRequote(async () => [], async () => { if (n++ === 0) throw Object.assign(new Error("x"), { code: "Reverted" }); return { ok: true }; }, () => undefined);
  assert.equal(r.resent, true); assert.equal(n, 2);
  let m = 0;
  await assert.rejects(sendWithRequote(async () => [], async () => { m++; throw Object.assign(new Error("t"), { code: "Timeout" }); }, () => undefined));
  assert.equal(m, 1);
});

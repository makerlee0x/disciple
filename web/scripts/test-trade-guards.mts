// SITE pre-send alerts + no-refuse pricing (lee, Oct 26 10:50–10:52 CDT). npm run test:trade-guards
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAlert, walletCapAlert, impactAlert, buyFill, FILL_OVERSHOOT, ROOM_MARGIN_BPS, COPY_PENDING_LEE } from "../lib/trade/tradeGuards";
import { noRefuseMinOut, holdInflightUntilSeen, sendWithRequote, roomCappedRange, tokensToWei, tradeMinOut } from "../lib/trade/queuePricing";

// EASY coin: 1 B supply, mcap $5,000 ⇒ $0.000005 / coin; cap 1 % (100 bps) = 10 M coins ≈ $50
const easy = { capBps: 100, supply: 1e9, holding: 0, priceUsd: 5e-6 };
const noCopy = (f: object) => assert.ok(!("note" in f) && !("warning" in f), "no copy (lee, Oct 31: fill silently)");
test("over-room buy is not held: it fills the WHOLE room silently (sends room × overshoot, minOut ceiling = room − 0.5 %)", () => {
  assert.equal(walletCapAlert(80, easy), null);
  const f = buyFill(80, easy);
  assert.equal(f.capped, true); noCopy(f);
  assert.equal(f.usd, 62.5, "room $50 × 1.25 = $62.50 (≤ typed $80)");
  assert.equal(f.fillUsd, 50, "the whole room fills");
  assert.equal(f.roomOut, 1e7 * (10_000 - ROOM_MARGIN_BPS) / 10_000, "minOut ceiling 0.5 % under the room");
  assert.equal((COPY_PENDING_LEE as Record<string, unknown>).walletFill, undefined, "the fill note copy is gone");
});
// $24.30 of room at the mark: room = 24.30 / 5e-6 = 4.86 M coins; holding = cap − room
const room2430 = { ...easy, holding: 1e7 - 24.30 / 5e-6 };
const ROOM = 24.30 / 5e-6;
test("$24.30 of room: $25 and $50 buys fill the full room (no hold, no note); a $10 buy is unchanged", () => {
  for (const usd of [25, 50]) {
    assert.equal(nextAlert("buy", usd, { cap: room2430 }), null, `$${usd}: not held`);
    const f = buyFill(usd, room2430);
    assert.equal(f.capped, true); noCopy(f);
    assert.equal(f.usd, Math.min(usd, 30.38), `$${usd} ⇒ sends ${f.usd} (covers fees + impact; the curve refunds the rest)`);
    assert.ok(f.usd >= 24.30, "sends at least the room's cost at the mark ⇒ fills ~100 % of the room");
    assert.ok(Math.abs(f.fillUsd - 24.30) < 1e-9, String(f.fillUsd));
    assert.ok(Math.abs(f.roomOut! - ROOM * 0.995) < 1e-3, String(f.roomOut));
  }
  assert.equal(buyFill(50, room2430).usd, 30.38, "$50 typed ⇒ $30.38 sent (24.30 × 1.25), $19.62 never leaves the wallet");
  assert.deepEqual(buyFill(10, room2430), { usd: 10, capped: false, fillUsd: 10 });
  assert.equal(nextAlert("buy", 10, { cap: room2430 }), null);
});
test("overshoot is capped at spendable cash (a short balance still fills what it can); unknown cash ⇒ not limited", () => {
  assert.equal(buyFill(50, room2430, 27.5).usd, 27.5);
  assert.equal(buyFill(50, room2430, 20).usd, 20);
  assert.equal(buyFill(50, room2430, 20).fillUsd, 20);
  assert.equal(buyFill(50, room2430, null).usd, 30.38);
  assert.equal(buyFill(50, room2430, 0).usd, 30.38, "no cash ⇒ the cash check refuses it (not sized to $0)");
});
test("minOut never exceeds the room: priced on min(quote, room − 0.5 %), with and without a one-tap session", () => {
  const f = buyFill(50, room2430);
  const cap = tokensToWei(f.roomOut!, 18), room = tokensToWei(ROOM, 18);
  assert.ok(cap < room && cap > (room * BigInt(9949)) / BigInt(10000));
  // cap-unaware quotes for $30.38 (model-scaled / TRENCH quoteBuy): ~6 M coins > the 4.86 M room
  for (const q of [{ lo: tokensToWei(6e6, 18), hi: tokensToWei(6.1e6, 18) }, { lo: tokensToWei(5e6, 18), hi: tokensToWei(5e6, 18) }]) {
    const r = roomCappedRange(q, cap);
    assert.ok(r.lo <= cap && r.hi <= cap);
    for (const [slip, sess] of [[9999, null], [1500, 1500], [500, 500], [100, null]] as const) {
      const mo = tradeMinOut(r, slip, sess, 100);
      assert.ok(mo <= cap && mo < room, `slip ${slip} session ${sess}: minOut ${mo} ≤ room`);
      if (sess) assert.ok(mo * BigInt(10_000) >= room * BigInt(10_000 - sess) * BigInt(9949) / BigInt(10_000), "still inside the session policy's window vs the capped on-chain quote");
    }
  }
  // a capped (trader-aware) quote already under the ceiling is untouched; no ceiling ⇒ unchanged
  const under = { lo: tokensToWei(4e6, 18), hi: tokensToWei(4.1e6, 18) };
  assert.deepEqual(roomCappedRange(under, cap), under);
  assert.deepEqual(roomCappedRange(under, undefined), under);
  assert.deepEqual(roomCappedRange(under, BigInt(0)), under);
  assert.equal(tokensToWei(1.5, 18), BigInt("1500000000000000000"));
  assert.equal(tokensToWei(0, 18), BigInt(0));
});
test("holdings + pending buys count against the room; full wallet (room 0) ⇒ held, no Buy max, nothing sent", () => {
  assert.ok(buyFill(30, { ...easy, holding: 5e6 }).capped);
  const p = buyFill(30, { ...easy, holding: 2e6, pendingBuyTokens: 3e6 });
  assert.ok(p.capped && p.fillUsd === 25 && p.usd === 30, JSON.stringify(p));
  for (const c of [{ ...easy, holding: 1e7 }, { ...easy, holding: 6e6, pendingBuyTokens: 4e6 }, { ...easy, holding: 2e7 }]) {
    const full = walletCapAlert(5, c)!;
    assert.equal(full.kind, "walletcap");
    assert.equal(full.maxUsd, 0); assert.equal(full.actionLabel, "");
    assert.equal(full.text, COPY_PENDING_LEE.walletFull("1%"));
    assert.equal(nextAlert("buy", 5, { cap: c })!.kind, "walletcap");
    assert.deepEqual(buyFill(5, c), { usd: 5, capped: false, fillUsd: 5 }, "buyFill never sizes a full wallet (the hold shows instead)");
  }
});
test("no cap (Trench / graduated) or unknown price ⇒ no wallet alert", () => {
  assert.equal(walletCapAlert(1e6, { ...easy, capBps: null }), null);
  assert.equal(walletCapAlert(1e6, { ...easy, priceUsd: 0 }), null);
  assert.deepEqual(buyFill(1e6, { ...easy, capBps: null }), { usd: 1e6, capped: false, fillUsd: 1e6 });
  assert.deepEqual(buyFill(1e6, { ...easy, priceUsd: 0 }), { usd: 1e6, capped: false, fillUsd: 1e6 });
  assert.deepEqual(buyFill(50, null), { usd: 50, capped: false, fillUsd: 50 });
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

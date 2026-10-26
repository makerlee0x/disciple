// SITE pre-send alerts + no-refuse pricing (lee, Oct 26 10:50–10:52 CDT). npm run test:trade-guards
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAlert, walletCapAlert, impactAlert, COPY_PENDING_LEE } from "../lib/trade/tradeGuards";
import { noRefuseMinOut, holdInflightUntilSeen, sendWithRequote } from "../lib/trade/queuePricing";

// EASY coin: 1 B supply, mcap $5,000 ⇒ $0.000005 / coin; cap 1 % (100 bps) = 10 M coins ≈ $50
const easy = { capBps: 100, supply: 1e9, holding: 0, priceUsd: 5e-6 };
test("Easy over-cap buy ⇒ wallet-limit alert with a buy-max amount; the max-allowed buy passes", () => {
  const a = walletCapAlert(80, easy)!;
  assert.equal(a.kind, "walletcap");
  assert.equal(a.capPct, "1%");
  assert.ok(a.maxUsd > 45 && a.maxUsd < 50, String(a.maxUsd));
  assert.equal(a.text, COPY_PENDING_LEE.walletCap("1%", a.maxUsd));
  assert.match(a.text, /^Wallet limit: this coin's mode caps each wallet at 1%\. You can buy up to about \$4\d\.\d\d more\.$/);
  assert.equal(walletCapAlert(a.maxUsd, easy), null, "buy max fits");
  assert.doesNotMatch(a.text, /revert|tx|0x|HTTP|relay/i);
});
test("holdings + pending buys count against the cap; full wallet ⇒ no buy-max", () => {
  assert.ok(walletCapAlert(30, { ...easy, holding: 5e6 }));
  assert.ok(walletCapAlert(30, { ...easy, holding: 2e6, pendingBuyTokens: 3e6 }));
  const full = walletCapAlert(5, { ...easy, holding: 1e7 })!;
  assert.equal(full.maxUsd, 0); assert.equal(full.actionLabel, "");
});
test("no cap (Trench / graduated) or unknown price ⇒ no wallet alert", () => {
  assert.equal(walletCapAlert(1e6, { ...easy, capBps: null }), null);
  assert.equal(walletCapAlert(1e6, { ...easy, priceUsd: 0 }), null);
});
test("> 10 % impact ⇒ warning (buy coins / sell $); ≤ 10 % or unknown ⇒ none", () => {
  assert.equal(impactAlert("sell", 1001, { usdOut: 12.345 })!.text, "High price impact: this sell moves the price over 10%. You'll get about $12.35.");
  assert.equal(impactAlert("buy", 2500, { coinsOut: 1_234_567 })!.text, "High price impact: this buy moves the price over 10%. You'll get about 1.23M coins.");
  assert.equal(impactAlert("sell", 1000, { usdOut: 1 }), null);
  assert.equal(impactAlert("buy", null, {}), null);
});
test("order: wallet limit first, then impact; confirmed kinds are skipped", () => {
  const i = { cap: easy, impactBps: 3000, expected: { coinsOut: 1e7 } };
  assert.equal(nextAlert("buy", 80, i)!.kind, "walletcap");
  assert.equal(nextAlert("buy", 80, i, ["walletcap"])!.kind, "impact");
  assert.equal(nextAlert("buy", 80, i, ["walletcap", "impact"]), null);
  assert.equal(nextAlert("sell", 80, { ...i, expected: { usdOut: 3 } })!.kind, "impact", "sells: no wallet cap");
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

/**
 * SITE job 7 — /api/trades fill value = the quote actually paid (buy) / received (sell) × the coin's launch quote price
 * (lib/trades fillUsd, lib/server/trades toFill), never tokens × a mid price; plus the stored-fill re-index
 * (revalueFill / replaceFill behind reindexFills). Run: npm run test:trade-value
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fillUsd, quoteUsd, type Fill } from "../lib/trades";
import { replaceFill, revalueFill, toFill } from "../lib/server/trades";

const B = (v: string | number) => BigInt(v);
// SGRAD's first buy on prod (curve venue): 2,616,460.73 STRATEGY for 841,654 tokens.
const QP = B("2482294971014410"); // SGRAD curve quotePriceUsd (≈ $0.00248229 per STRATEGY)
const SGRAD_BUY = {
  token: "0x00000000000000000000000000000000000000a1", trader: "0x00000000000000000000000000000000000000b2", isBuy: true,
  quoteAmt: B("2616460728540461770818078"), tokenAmt: B("841654001599965323827944"),
  priceBeforeX18: B("1342709081281320277"), priceAfterX18: B("13222603954391041495"),
  mcapAfterUsd: B("32822403299700133393946"), quotePriceUsd: QP, supplyTokens: 1_000_000_000,
};
const LOG = { transactionHash: "0xabc", logIndex: 3, blockNumber: B(100) };

test("SGRAD first buy: 2,616,460.73 STRATEGY ⇒ ≈ $6.5K (was $15.2K from tokens × mid price)", () => {
  const u = fillUsd(SGRAD_BUY);
  assert.ok(Math.abs(u.usd - 6494.83) < 0.01, `usd ${u.usd}`);
  assert.equal(u.usdBasis, "quote");
  // the old estimate, for the record: tokens × average(before, after) price × quote price
  const mid = ((Number(SGRAD_BUY.priceBeforeX18) + Number(SGRAD_BUY.priceAfterX18)) / 2 / 1e18) * (Number(QP) / 1e18);
  assert.ok(Math.abs(u.tokens * mid - 15215.17) < 1, `old ${u.tokens * mid}`);
  const f = toFill(LOG, "curve", SGRAD_BUY, 1_000);
  assert.ok(Math.abs(f.usd - 6494.83) < 0.01);
  assert.equal(f.side, "buy"); assert.equal(f.usdBasis, "quote");
});

test("sells are symmetric: usd = quote received × quote price (hook sell 87,677.63 STRATEGY ⇒ ≈ $217.64)", () => {
  const sell = { ...SGRAD_BUY, isBuy: false, quoteAmt: B("87677625718893256842577"), tokenAmt: B("30000000000000000000000") };
  const u = fillUsd(sell);
  assert.ok(Math.abs(u.usd - 217.64) < 0.01, `usd ${u.usd}`);
  // same quote amount ⇒ same $ either side, whatever the price path
  const buy = fillUsd({ ...sell, isBuy: true, priceBeforeX18: B(1), priceAfterX18: B("99999999999999999999") });
  assert.equal(buy.usd, u.usd);
  assert.equal(quoteUsd(B("1000000000000000000"), B("1000000000000000000")), 1, "USDG-style $1 quote: 1 unit = $1");
});

test("no quoteAmt / no quote price ⇒ falls back to the old estimate, tokens × mid price (usdBasis 'price')", () => {
  const noQ: Partial<typeof SGRAD_BUY> = { ...SGRAD_BUY }; delete noQ.quoteAmt;
  const u = fillUsd(noQ as typeof SGRAD_BUY);
  assert.equal(u.usdBasis, "price");
  const mid = u.priceUsd * ((Number(SGRAD_BUY.priceAfterX18) + Number(SGRAD_BUY.priceBeforeX18)) / 2 / Number(SGRAD_BUY.priceAfterX18));
  assert.ok(Math.abs(u.usd - u.tokens * mid) < 1e-6, `fallback ${u.usd}`);
  // coarse (6-dec USDG) prices ⇒ no mid factor: tokens × price after
  const c = fillUsd({ ...(noQ as typeof SGRAD_BUY), priceBeforeX18: B(1), priceAfterX18: B(2) });
  assert.ok(Math.abs(c.usd - c.tokens * c.priceUsd) < 1e-9);
  assert.equal(fillUsd({ ...SGRAD_BUY, quotePriceUsd: B(0), mcapAfterUsd: B("1000000000000000000000") }).usdBasis, "price");
});

test("router USDG path unchanged: usdIn/usdOut come from UsdgTrade, usd from the quote", () => {
  const f = toFill(LOG, "curve", SGRAD_BUY, 1_000, { trader: SGRAD_BUY.trader, token: SGRAD_BUY.token, isBuy: true, amountIn: B(6_588) * B(10) ** B(18), amountOut: B("841654001599965323827944") });
  assert.ok(Math.abs(f.usd - 6494.83) < 0.01);
  assert.ok(f.usdIn !== undefined && f.usdIn > 0, "usdIn kept from the router event");
  assert.equal(f.usdOut, undefined);
});

test("re-index: an old fill is revalued (id/ts/usdIn kept) and is idempotent; replaceFill swaps the members", async () => {
  const fresh = toFill(LOG, "curve", SGRAD_BUY, 1_000);
  const old: Fill = { ...fresh, usd: 15215.17, usdIn: 6588 }; delete old.usdBasis;   // as stored before job 7
  const oldMember = JSON.stringify(old);
  const nf = revalueFill(old, "curve", { ...SGRAD_BUY });
  assert.ok(Math.abs(nf.usd - 6494.83) < 0.01);
  assert.equal(nf.id, old.id); assert.equal(nf.ts, old.ts); assert.equal(nf.usdIn, 6588); assert.equal(nf.usdBasis, "quote");
  assert.equal(JSON.stringify(revalueFill(nf, "curve", { ...SGRAD_BUY })), JSON.stringify(nf), "second pass = no change");

  const z = new Map<string, Map<string, number>>();
  const store = {
    async zadd(k: string, ms: { score: number; member: string }[]) { const m = z.get(k) ?? new Map(); let n = 0; for (const x of ms) if (!m.has(x.member)) { m.set(x.member, x.score); n++; } z.set(k, m); return n; },
    async zrem(k: string, ...ms: string[]) { const m = z.get(k); let n = 0; for (const x of ms) if (m?.delete(x)) n++; return n; },
  };
  const coin = old.coin, wk = `trades:w:${old.trader}:${coin}`;
  await store.zadd(`trades:${coin}`, [{ score: old.ts, member: oldMember }]);
  await store.zadd(wk, [{ score: old.ts, member: oldMember }]);
  await replaceFill(store as never, coin, oldMember, nf);
  await replaceFill(store as never, coin, oldMember, nf); // repeat (e.g. a retried run) — still one member
  for (const k of [`trades:${coin}`, wk]) assert.deepEqual(Array.from(z.get(k)!.keys()), [JSON.stringify(nf)]);
});

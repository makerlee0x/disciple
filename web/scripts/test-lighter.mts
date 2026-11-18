/** Lighter integration: order math, key sealing, and the real WASM signer (offline). `npm run test:lighter` */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { atLeastMin, baseAmountFor, bpToFeeUnits, minBaseFor, clientOrderIndex, levFraction, roundTripBp, worstPrice } from "../lib/lighter/math";
import { open, seal } from "../lib/server/lighter/keys";

test("fees: 0.05 bp a side is 5 Lighter units; Plus + ours = 1.1 bp round trip", () => {
  assert.equal(bpToFeeUnits(0.05), 5);
  assert.equal(bpToFeeUnits(0.1), 10);
  assert.equal(bpToFeeUnits(1), 100);
  assert.equal(roundTripBp(0.5, 0.05), 1.1);
});
test("leverage fraction: 50x → 200, 20x → 500", () => { assert.equal(levFraction(50), 200); assert.equal(levFraction(20), 500); });
test("base size rounds down; price cap is on the right side", () => {
  // $10 × 50x at $95,000 with 5 size decimals = 0.00526315 BTC → 526
  assert.equal(baseAmountFor(500, 95_000, 5), 526);
  assert.equal(baseAmountFor(0, 95_000, 5), 0);
  assert.equal(worstPrice(95_000, false, 0.005, 1), 954750); // buy: cap above
  assert.equal(worstPrice(95_000, true, 0.005, 1), 945250);  // sell: floor below
});
test("client order index fits 48 bits and changes", () => {
  const a = clientOrderIndex(), b = clientOrderIndex();
  assert.ok(a < 2 ** 48 && b < 2 ** 48); assert.notEqual(a, b);
});
test("trading keys round-trip through AES-GCM and fail on a wrong secret", () => {
  const s = seal("0123456789abcdef-secret", "0xdeadbeef");
  assert.equal(open("0123456789abcdef-secret", s), "0xdeadbeef");
  assert.throws(() => open("another-secret-0123456", s));
});
test("WASM signer: market order with Disciple's partner fee, key registration and approval messages", async () => {
  const dir = path.join(process.cwd(), "lib/server/lighter/signer");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.Go) vm.runInThisContext(fs.readFileSync(path.join(dir, "wasm_exec.js"), "utf8"));
  const go = new g.Go();
  const { instance } = await WebAssembly.instantiate(zlib.gunzipSync(fs.readFileSync(path.join(dir, "lighter-signer.wasm.gz"))), go.importObject);
  void go.run(instance);
  const key = g.GenerateAPIKey();
  assert.ok(key.privateKey && key.publicKey);
  assert.deepEqual(g.CreateClient("", key.privateKey, 300, 7, 1234), {});
  const o = g.SignCreateOrder(1, 42, 526, 954750, 0, 1, 0, 0, 0, 0, 999, 5, 0, 0, 0, 0, 3, 7, 1234);
  assert.equal(o.error, undefined);
  const info = JSON.parse(o.txInfo);
  assert.equal(info.Type, 1); assert.equal(info.TimeInForce, 0); assert.equal(info.BaseAmount, 526);
  assert.match(o.txInfo, /999/); // integrator account rides on the order
  const ck = g.SignChangePubKey(key.publicKey, 0, 0, 7, 1234);
  assert.match(ck.messageToSign, /Register Lighter Account/);
  const ap = g.SignApproveIntegrator(999, 5, 0, 0, 0, Date.now() + 86_400_000, 0, 4, 7, 1234);
  assert.match(ap.messageToSign, /Approve Integrator/);
  // Turbo cash → Cash: a transfer to the fast-withdraw pool, memo = destination + 12 zero bytes, needs the owner's L1 sig
  const memo = "0x" + "ab".repeat(20) + "00".repeat(12);
  const tr = g.SignTransfer(88, 3, 0, 0, 5_000_000, 20_000, memo, 0, 5, 7, 1234);
  assert.equal(tr.error, undefined);
  const ti = JSON.parse(tr.txInfo);
  assert.equal(ti.ToAccountIndex, 88); assert.equal(ti.Amount, 5_000_000); assert.equal(ti.USDCFee, 20_000);
  assert.ok(tr.messageToSign, "transfer has a message for the owner's wallet");
});
test("withdraw memo: destination address then 12 zero bytes", async () => {
  const { withdrawMemo } = await import("../lib/server/lighter/withdraw");
  const m = withdrawMemo("0xAbCdEf0123456789abcdef0123456789ABCDEF01");
  assert.equal(m, "0xabcdef0123456789abcdef0123456789abcdef01" + "00".repeat(12));
  assert.equal(m.length, 2 + 64);
  assert.throws(() => withdrawMemo("0x123"));
});

test("Royale reads Lighter market_stats: one market, the /all map, by symbol or by id", async () => {
  const { parseLighterStats } = await import("../lib/turbo/royalePrices");
  const ids = new Map([[1, "BTC" as const], [24, "HYPE" as const]]);
  assert.deepEqual(parseLighterStats({ market_stats: { market_id: 1, mark_price: "104000.5" } }, ids), { BTC: 104000.5 });
  assert.deepEqual(parseLighterStats({ market_stats: { "1": { market_id: 1, mark_price: "104000" }, "24": { market_id: 24, mark_price: "44.1" }, "9": { market_id: 9, mark_price: "3" } } }, ids), { BTC: 104000, HYPE: 44.1 });
  assert.deepEqual(parseLighterStats({ market_stats: { market_id: 77, symbol: "sol", last_trade_price: "201" } }, ids), { SOL: 201 });
  assert.deepEqual(parseLighterStats({ type: "pong" }, ids), {});
});

test("Royale charts never jump venues: once Lighter prices a coin it stays on Lighter", async () => {
  const { royaleMerge } = await import("../lib/turbo/royalePrices");
  const m = royaleMerge();
  m.hyperliquid({ BTC: 104010, HYPE: 44 });
  assert.deepEqual(m.prices(), { BTC: 104010, HYPE: 44 });
  m.lighter({ BTC: 104000 });
  m.hyperliquid({ BTC: 104050, HYPE: 44.2 });
  assert.deepEqual(m.prices(), { BTC: 104000, HYPE: 44.2 });   // BTC holds Lighter's last price; HYPE has no Lighter price yet
});

test("every position meets Lighter's minimum (rounded up)", () => {
  // BTC on Lighter's Robinhood Chain exchange: min 0.00020 BTC, min $10, 5 size decimals
  const m = minBaseFor("0.00020", "10.000000", 63_000, 5);
  assert.equal(m, 20);
  assert.equal(minBaseFor("0.00020", "10", 30_000, 5), 34);  // at a low price the $10 minimum is the bigger one
  assert.equal(atLeastMin(baseAmountFor(0.5, 63_000, 5), m, true), 20);  // a 50-cent bet becomes the minimum
  assert.equal(atLeastMin(baseAmountFor(500, 63_000, 5), m, true), 793); // a big bet is untouched
  assert.equal(atLeastMin(0, m, false), 0);                               // no bet stays no bet
});

test("Relay deposit quote: deposit address, what lands, its fee; bad answers throw", async () => {
  const { parseRelayDeposit } = await import("../lib/server/lighter/bridge");
  // trimmed from a live quote, 2026-11-18: $10 USDG on Robinhood Chain -> USDC on Arbitrum
  const d = parseRelayDeposit({ steps: [{ id: "deposit", depositAddress: "0xf907095ab72a27899bb909f0f4e94bfe15ddb5ce" }], details: { currencyOut: { amount: "9961351" } }, fees: { relayer: { amountUsd: "0.037972" } } });
  assert.equal(d.address, "0xf907095ab72a27899bb909f0f4e94bfe15ddb5ce");
  assert.equal(d.outUsd, 9.961351);
  assert.equal(d.feeUsd, 0.037972);
  assert.throws(() => parseRelayDeposit({ steps: [{ id: "approve" }] }));
  assert.throws(() => parseRelayDeposit({ steps: [{ id: "deposit", depositAddress: "0x12" }], details: { currencyOut: { amount: "1" } } }));
  assert.throws(() => parseRelayDeposit({ steps: [{ id: "deposit", depositAddress: "0xf907095ab72a27899bb909f0f4e94bfe15ddb5ce" }] }));
});

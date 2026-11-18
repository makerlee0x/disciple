/** Lighter integration: order math, key sealing, and the real WASM signer (offline). `npm run test:lighter` */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { baseAmountFor, bpToFeeUnits, clientOrderIndex, levFraction, roundTripBp, worstPrice } from "../lib/lighter/math";
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
});

test("Royale reads Lighter market_stats: one market, the /all map, by symbol or by id", async () => {
  const { parseLighterStats } = await import("../lib/turbo/royalePrices");
  const ids = new Map([[1, "BTC" as const], [24, "HYPE" as const]]);
  assert.deepEqual(parseLighterStats({ market_stats: { market_id: 1, mark_price: "104000.5" } }, ids), { BTC: 104000.5 });
  assert.deepEqual(parseLighterStats({ market_stats: { "1": { market_id: 1, mark_price: "104000" }, "24": { market_id: 24, mark_price: "44.1" }, "9": { market_id: 9, mark_price: "3" } } }, ids), { BTC: 104000, HYPE: 44.1 });
  assert.deepEqual(parseLighterStats({ market_stats: { market_id: 77, symbol: "sol", last_trade_price: "201" } }, ids), { SOL: 201 });
  assert.deepEqual(parseLighterStats({ type: "pong" }, ids), {});
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { decodeTrade, tradeAbi } from "../src/trades.ts";

const ID = "0x8a1d5f363db9d4a7b874abc858a8fdc86786a9208835aa8360b953cad223b8cd" as Hex;
const who = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Hex;

function swapLog(a0: bigint, a1: bigint, f0: bigint, f1: bigint) {
  const topics = encodeEventTopics({ abi: tradeAbi, eventName: "HookSwap", args: { id: ID, sender: who } }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters(
    [{ type: "int128" }, { type: "int128" }, { type: "uint128" }, { type: "uint128" }],
    [a0, a1, f0, f1],
  );
  return { topics, data };
}

test("buy: USDG in, STRATEGY out", () => {
  // the live $1 buy: 1 USDG -> 525.485 STRATEGY, fee 1% of input
  const t = decodeTrade(swapLog(-525_485n * 10n ** 15n, 1_000_000n, 0n, 10_000n));
  assert.equal(t.kind, "BUY");
  assert.equal(t.quote, 1_000_000n);
  assert.equal(t.coin, 525_485n * 10n ** 15n);
  assert.equal(t.feeQuote, 0.01);
});

test("sell: STRATEGY in, fee valued at the trade price", () => {
  const t = decodeTrade(swapLog(5000n * 10n ** 18n, -9_500_000n, 50n * 10n ** 18n, 0n));
  assert.equal(t.kind, "SELL");
  assert.ok(Math.abs(t.feeQuote - 0.095) < 1e-9);
});

test("deposit and withdraw", () => {
  const topics = encodeEventTopics({ abi: tradeAbi, eventName: "HookModifyLiquidity", args: { id: ID, sender: who } }) as [Hex, ...Hex[]];
  const d = (a0: bigint, a1: bigint) =>
    decodeTrade({ topics, data: encodeAbiParameters([{ type: "int128" }, { type: "int128" }], [a0, a1]) });
  assert.equal(d(10n ** 18n, 10n ** 6n).kind, "DEPOSIT");
  assert.equal(d(-(10n ** 18n), -(10n ** 6n)).kind, "WITHDRAW");
});

test("summary: counts, volume, fee APY", async () => {
  const { readRows, summarise } = await import("../src/trades.ts");
  const csv = [
    "time_utc,block,tx,kind,strategy,usdg,price_usdg,lp_fee_usdg,tx_from,tx_to",
    "2026-11-09T00:00:00Z,1,0xa,BUY,5000,10,0.002,0.1,0x1,0x2",
    "2026-11-09T01:00:00Z,2,0xb,SELL,5000,9.5,0.0019,0.095,0x1,0x2",
    "2026-11-09T02:00:00Z,3,0xc,DEPOSIT,100,1,0.01,0,0x1,0x2",
  ].join("\n");
  const launch = Date.parse("2026-11-08T00:00:00Z");
  const out = summarise(readRows(csv), 200, launch + 2 * 86_400_000, launch);
  assert.match(out[0], /^2 trades \(1 buys, 1 sells\) in 2\.00 days/);
  assert.match(out[1], /volume \$19\.50 total/);
  assert.match(out[2], /LP fees \$0\.1950/);
  assert.match(out[3], /fee APY 17\.8%/); // 0.195 / 200 * 365 / 2
});

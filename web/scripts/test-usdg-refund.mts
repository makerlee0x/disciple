// usdIn NET of the router's UsdgRefund (achievements-server commit 1). Pure + a golden receipt (no network):
//   pnpm test:usdg-refund
// Golden: SGRAD graduating BOOST tx 0x22f3…1843 (RH testnet 46630). UsdgTrade.amountIn = 25.025002 USDG,
// UsdgRefund.usdgRefund = 0.024851 USDG ⇒ net paid $25.000151 (6-dec USDG). The paymaster's gas charge in the same tx
// is NOT a UsdgRefund and must not be netted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attachRefunds, usdgAmounts, usdgIndex, usdgKey, FILL_V, type UsdgTradeArgs } from "../lib/trades";

process.env.NEXT_PUBLIC_USDG_DECIMALS ??= "6";
const { usdgFromReceiptLogs, revalueFill } = await import("../lib/server/trades");

const ROUTER = "0x688160633b22012717661545df6299d3d3174ad2";
const SGRAD = "0x4c0b30188f5ff953ac81499ec421c71074a2cb99";
const fx = JSON.parse(readFileSync(new URL("./fixtures/sgrad-grad-receipt.json", import.meta.url), "utf8")) as { tx: string; block: number; logs: { address: string; topics: string[]; data: string; logIndex: number }[] };

const buy = (o: Partial<UsdgTradeArgs> = {}): UsdgTradeArgs => ({ trader: "0xaa", token: "0xcc", isBuy: true, amountIn: BigInt(25_025_002), amountOut: BigInt(1), ...o });

test("usdgAmounts: buy without refund = gross; with refund = net + usdInGross", () => {
  assert.deepEqual(usdgAmounts(buy(), 6), { usdIn: 25.025002 });
  const r = usdgAmounts(buy({ usdgRefund: BigInt(24_851) }), 6);
  assert.equal(r.usdIn!.toFixed(6), "25.000151");
  assert.equal(r.usdInGross, 25.025002);
  assert.deepEqual(usdgAmounts(buy({ isBuy: false, amountIn: BigInt(5), amountOut: BigInt(9_000_000) }), 6), { usdOut: 9 });
  // refund > amountIn never goes negative
  assert.equal(usdgAmounts(buy({ amountIn: BigInt(10), usdgRefund: BigInt(99) }), 6).usdIn, 0);
});

test("attachRefunds: same tx/token/trader, first un-refunded buy only; foreign refund ignored", () => {
  const ts = [
    { tx: "0xT", args: buy({ isBuy: false }) },
    { tx: "0xT", args: buy() },
    { tx: "0xT", args: buy() },
    { tx: "0xU", args: buy() },
  ];
  attachRefunds(ts, [
    { tx: "0xt", args: { trader: "0xAA", token: "0xCC", quoteRefund: BigInt(1), usdgRefund: BigInt(7) } },
    { tx: "0xT", args: { trader: "0xbb", token: "0xcc", quoteRefund: BigInt(1), usdgRefund: BigInt(9) } },   // other trader
  ]);
  assert.equal(ts[0].args.usdgRefund, undefined);
  assert.equal(ts[1].args.usdgRefund, BigInt(7));
  assert.equal(ts[2].args.usdgRefund, undefined);
  assert.equal(ts[3].args.usdgRefund, undefined);
  const idx = usdgIndex(ts);
  assert.equal(idx.get(usdgKey("0xT", "0xcc", true))![0].usdgRefund, BigInt(7));
});

test("golden SGRAD graduating BOOST: receipt → net usdIn $25.000151", () => {
  const trade = fx.logs.find((l) => l.logIndex === 14)!;
  assert.ok(trade, "curve Trade at log 14");
  const u = usdgFromReceiptLogs(fx.logs, ROUTER, 14, { token: SGRAD, isBuy: true });
  assert.ok(u, "matched UsdgTrade");
  assert.equal(u!.amountIn, BigInt(25_025_002));
  assert.equal(u!.usdgRefund, BigInt(24_851));
  const a = usdgAmounts(u, 6);
  assert.equal(a.usdIn!.toFixed(6), "25.000151");
  assert.equal(a.usdInGross, 25.025002);
  // a foreign "router" address ⇒ nothing trusted
  assert.equal(usdgFromReceiptLogs(fx.logs, "0x000000000000000000000000000000000000dead", 14, { token: SGRAD, isBuy: true }), undefined);
});

test("revalueFill recomputes usdIn from the receipt (was copied forward) and stamps FILL_V", () => {
  const old = { id: `${fx.tx}:14`, tx: fx.tx, logIndex: 14, block: fx.block, ts: 1, coin: SGRAD, trader: "0xe320", side: "buy" as const, venue: "curve" as const,
    tokens: 1, usd: 24.92, priceUsd: 1, mcapUsd: 1, usdIn: 25.025002, usdBasis: "quote" as const };
  const a = { token: SGRAD, trader: "0xe320", isBuy: true, tokenAmt: BigInt(10) ** BigInt(18), quoteAmt: BigInt(24_920_000), quotePriceUsd: BigInt(10) ** BigInt(30),
    priceBeforeX18: BigInt(1), priceAfterX18: BigInt(1), mcapAfterUsd: BigInt(10) ** BigInt(18) };
  const u = { ...buy({ trader: "0xe320", token: SGRAD }), usdgRefund: BigInt(24_851) };
  const nf = revalueFill(old, "curve", a, u);
  assert.equal(nf.usdIn!.toFixed(6), "25.000151");
  assert.equal(nf.v, FILL_V);
  // no router leg found ⇒ stored usdIn kept, never dropped
  assert.equal(revalueFill(old, "curve", a).usdIn, 25.025002);
});

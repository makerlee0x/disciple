// usdIn NET of the router's UsdgRefund (achievements-server commit 1). Pure + a golden receipt (no network):
//   pnpm test:usdg-refund
// Golden: SGRAD graduating BOOST tx 0x22f3…1843 (RH testnet 46630, block 142139099). Re-verified log by log (Oct 26):
//  - log 55 UsdgRefund is emitted by the DiscipleRouter 0x6881…4ad2 (NOT the paymaster): quoteRefund 10.041 STRATEGY
//    (the curve's unused quote on the graduating buy, DiscipleRouter.sol:349-354), swapped back to USDG through the
//    PoolManager (log 52 Swap, sender = router, 24851 out; log 53 STRATEGY router→PoolManager; log 54 USDG
//    PoolManager→trader 24851) ⇒ usdgRefund 0.024851 USDG.
//  - log 56 UsdgTrade.amountIn = 25.025002 USDG = only what the router pulled for the trade (usdgIn). No gas in it.
//  - the AA gas is separate: log 57 USDG trader→treasury 0.092457 and log 58 DisciplePaymaster 0xB3DB…7d7E
//    UserOperationCharged(gasCostToken 92457, debtRepaid 0). The paymaster emitted NO refund in this tx.
// ⇒ trade usdIn = 25.025002 − 0.024851 = $25.000151 (gas excluded). Only router-emitted UsdgRefund logs are netted.
// It is the ONLY UsdgRefund ever emitted by any DiscipleRouter in contracts/deployments (all 5 routers scanned from
// block 120M to 143.05M on Oct 26), so it is the only real refund fixture on testnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attachRefunds, usdgAmounts, usdgIndex, usdgKey, FILL_V, type UsdgTradeArgs } from "../lib/trades";

process.env.NEXT_PUBLIC_USDG_DECIMALS ??= "6";
const { usdgFromReceiptLogs, revalueFill } = await import("../lib/server/trades");

const ROUTER = "0x688160633b22012717661545df6299d3d3174ad2";
const SGRAD = "0x4c0b30188f5ff953ac81499ec421c71074a2cb99";
const PAYMASTER = "0xb3db53c1e94f146194756ff456479ea0577e7d7e";
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
  // gas is not trade value: the paymaster's 0.092457 charge never enters usdIn (neither added nor netted)
  assert.ok(fx.logs.some((l) => l.address.toLowerCase() === PAYMASTER && l.logIndex === 58), "paymaster UserOperationCharged in fixture");
  // a UsdgRefund-shaped log emitted by the PAYMASTER (forged, = its 92457 gas charge) is ignored: only the router's counts
  const rr = fx.logs.find((l) => l.logIndex === 55)!;
  assert.equal(rr.address.toLowerCase(), ROUTER, "the real UsdgRefund is router-emitted");
  const forged = { ...rr, address: PAYMASTER, logIndex: 60, data: rr.data.slice(0, 66) + (92457).toString(16).padStart(64, "0") };
  const u2 = usdgFromReceiptLogs([...fx.logs.filter((l) => l.logIndex !== 55), forged], ROUTER, 14, { token: SGRAD, isBuy: true });
  assert.equal(u2!.usdgRefund, undefined);
  assert.equal(usdgAmounts(u2, 6).usdIn, 25.025002);
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

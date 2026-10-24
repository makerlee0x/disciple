/** 6-dec USDG: config-driven decimals + the single $ ⇄ USDG raw helper, for BOTH 18 (today's testnet) and 6. Run: pnpm test:usdg-decimals */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_RHT_USDG_DECIMALS = "6";   // the ~Nov 2 testnet redeploy setting (read when chains.ts loads)
const { DEPLOYMENTS, decimalsEnv } = await import("../lib/chains");
const { usdToUsdgRaw, usdgRawToUsd, usdgPriceWadPer1e18Raw, knownDecimals, isUsdg } = await import("../lib/usdg");
const { usdCapRaw } = await import("../lib/aa/oneTap");
const { usdgAmounts } = await import("../lib/trades");

const B = (x: number | string) => BigInt(x);
const USDG = "0x25030Bff74764aD72b912276a603717DB1C00644", STRAT = "0xd4d0eb01960aace441bfcb323bfaf7c3d8b555a3";

test("config: one usdgDecimals per chain (mainnet 6, testnet env-driven, default 18)", () => {
  const mainnet = Object.values(DEPLOYMENTS).find((d) => d.usdg.toLowerCase() === "0x5fc5360d0400a0fd4f2af552add042d716f1d168")!;
  assert.equal(mainnet.usdgDecimals, 6, "mainnet USDG");
  assert.equal(DEPLOYMENTS[46630].usdgDecimals, 6, "NEXT_PUBLIC_RHT_USDG_DECIMALS=6 drives testnet");
  assert.equal(decimalsEnv(undefined, 18), 18, "unset ⇒ today's 18-dec mUSDG");
  assert.equal(decimalsEnv("6", 18), 6);
  for (const bad of ["", "x", "-1", "99", "6.5"]) assert.equal(decimalsEnv(bad, 18), 18, `rejects ${JSON.stringify(bad)}`);
});

for (const dec of [18, 6]) {
  const one = B(10) ** B(dec);
  test(`${dec}-dec: usdToUsdgRaw / usdgRawToUsd round-trip`, () => {
    assert.equal(usdToUsdgRaw(1, dec), one);
    assert.equal(usdToUsdgRaw(20, dec), B(20) * one);
    assert.equal(usdToUsdgRaw(0.2, dec), (B(2) * one) / B(10));
    assert.equal(usdToUsdgRaw(1.234567891, dec), (B(1_234_568) * one) / B(1_000_000), "rounded to 6 dp");
    assert.equal(usdToUsdgRaw(0, dec), B(0)); assert.equal(usdToUsdgRaw(-5, dec), B(0)); assert.equal(usdToUsdgRaw(NaN, dec), B(0));
    assert.equal(usdgRawToUsd(B(54_760_000) * (one / B(1_000_000)), dec), 54.76);
    for (const usd of [0.01, 0.2, 1, 25, 54.76, 25_000]) assert.equal(usdgRawToUsd(usdToUsdgRaw(usd, dec), dec), usd);
  });
  test(`${dec}-dec: $1 price (QuotePricer units) and spend cap agree with the helper`, () => {
    assert.equal(usdgPriceWadPer1e18Raw(dec), B(10) ** B(36 - dec));     // 1e18 (18-dec) / 1e30 (6-dec, per IQuotePricer)
    assert.equal(usdCapRaw(25_000, usdgPriceWadPer1e18Raw(dec)), usdToUsdgRaw(25_000, dec), "$25k cap = 25k USDG raw");
  });
  test(`${dec}-dec: UsdgTrade → usdIn/usdOut`, () => {
    assert.deepEqual(usdgAmounts({ trader: USDG, token: STRAT, isBuy: true, amountIn: usdToUsdgRaw(12.5, dec), amountOut: B(1) }, dec), { usdIn: 12.5 });
    assert.deepEqual(usdgAmounts({ trader: USDG, token: STRAT, isBuy: false, amountIn: B(1), amountOut: usdToUsdgRaw(3.75, dec) }, dec), { usdOut: 3.75 });
  });
}

test("knownDecimals: USDG from config (no RPC), STRATEGY 18, unknown ⇒ undefined (read on-chain, never guessed)", () => {
  const d6 = { usdg: USDG as `0x${string}`, usdgDecimals: 6, defaultQuote: STRAT as `0x${string}` };
  const d18 = { ...d6, usdgDecimals: 18 };
  assert.equal(knownDecimals(USDG.toLowerCase(), d6), 6);
  assert.equal(knownDecimals(USDG, d18), 18);
  assert.equal(knownDecimals(STRAT, d6), 18);
  assert.equal(knownDecimals("0x000000000000000000000000000000000000beef", d6), undefined);
  assert.ok(isUsdg(USDG.toUpperCase().replace("0X", "0x"), d6)); assert.ok(!isUsdg(STRAT, d6)); assert.ok(!isUsdg(null, d6));
});

// FLOW #115: at 6-dec USDG the 1e18-scaled price fields (priceAfterX18, spotPriceWad, MarketLens priceWad) floor to
// single digits — the site prices from mcapAfterUsd / sqrtPriceAfter / mcapNow instead.
test("6-dec: hook Trade mcap from sqrtPriceAfter (launch quote price, lib/mcap), not the floored priceAfterX18", async () => {
  const { hookTradeMcapUsd } = await import("../lib/events");
  const { mcapUsdFromSqrt } = await import("../lib/trades");
  const px = 33_000 * 1e6 / 7e27;                                   // quote raw per token raw at $33K mcap, 6-dec USDG
  const lo = "0x" + "11".repeat(20), hi = "0x" + "ee".repeat(20);
  const s0 = BigInt(Math.round(Math.sqrt(px) * 2 ** 80)) << BigInt(16), s1 = BigInt(Math.round(Math.sqrt(1 / px) * 2 ** 48)) << BigInt(48);
  const q = B(10) ** B(30);                                          // $1 USDG in QuotePricer units (6-dec)
  const near = (a: number, b: number) => assert.ok(Math.abs(a / b - 1) < 1e-6, `${a} ≈ ${b}`);
  near(mcapUsdFromSqrt(s0, true, q), 33_000);
  near(mcapUsdFromSqrt(s1, false, q), 33_000);
  near(hookTradeMcapUsd({ token: lo, sqrtPriceAfter: s0, priceAfterX18: B(4) }, q, { quote: hi }), 33_000);
  near(hookTradeMcapUsd({ token: hi, sqrtPriceAfter: s1, priceAfterX18: B(4) }, q, { quote: lo, supplyTokens: 7e9 }), 33_000);
});
test("6-dec: curve impact from token reserves, not floored spotPriceWad", async () => {
  const { impactPctBetween, spotPriceWad } = await import("../lib/curveMath");
  // tiny x0 (6-dec quote) ⇒ spotPriceWad is 0–5, but the impact must still be exact
  const p = { totalSupply: B(7e9) * B(10) ** B(18), sCurve: B(504e7) * B(10) ** B(18), x0: B(2_100_000_000), y0: B(9e9) * B(10) ** B(18) };
  assert.ok(spotPriceWad(p, B(0)) < B(10), "fixture really is coarse");
  const before = B(1e9) * B(10) ** B(18), after = B(11e8) * B(10) ** B(18);
  const exact = ((8e9 / 7.9e9) ** 2 - 1) * 100;
  assert.ok(Math.abs(impactPctBetween(p, before, after) - exact) < 1e-9);
});

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

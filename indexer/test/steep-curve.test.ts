import { describe, it, expect } from "vitest";
import {
  CURVE_GRADUATION_MCAP_USD, CURVE_SOLD_BPS, CURVE_START_MCAP_USD, TOTAL_SUPPLY,
  graduationSqrtPriceX96, mcapUsdFromSqrt,
} from "../src/math";
import { tradeUsd } from "../src/usd";

const WAD = 10n ** 18n;

describe("steep curve parity (Constants.sol / BondingCurve)", () => {
  it("constants", () => {
    expect(CURVE_START_MCAP_USD).toBe(3_333);
    expect(CURVE_GRADUATION_MCAP_USD).toBe(33_333);
    expect(CURVE_SOLD_BPS).toBe(8424n);
  });

  for (const dec of [18, 6]) {
    for (const tokenIsC0 of [true, false]) {
      it(`graduation pool reads back $33,333 (${dec}-dec quote, tokenIsC0=${tokenIsC0})`, () => {
        const one = 10n ** BigInt(dec);
        const mcapQuote = 33_333n * one; // curve end, quote at $1
        const sqrtP = graduationSqrtPriceX96(mcapQuote, TOTAL_SUPPLY, tokenIsC0);
        // quoteUsdWad = USD WAD per 1e18 raw quote
        const quoteUsdWad = WAD * (10n ** BigInt(18 - dec)) ;
        const m = mcapUsdFromSqrt(sqrtP, tokenIsC0, quoteUsdWad, TOTAL_SUPPLY);
        const err = Number(m - 33_333n * WAD) / 1e18;
        expect(Math.abs(err)).toBeLessThan(33_333 * 1e-9); // floor-sqrt dust only
      });
    }
  }

  it("curve Trade: mcap comes straight from the event (curve-agnostic)", () => {
    const u = tradeUsd({ quotePriceUsdWad: WAD.toString(), quoteAmt: 10n * WAD, priceAfterX18: 33_333n * 10n ** 12n, mcapAfterUsd: 33_333n * WAD });
    expect(u.mcapUsdWad).toBe((33_333n * WAD).toString());
    expect(u.volumeUsd).toBeCloseTo(10);
    expect(u.priceUsd).toBeCloseTo(0.033333, 9);
  });
});

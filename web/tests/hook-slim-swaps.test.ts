/**
 * Slim DiscipleHook (2026-11-17): the hook emits nothing, so post-grad trades are rebuilt from the PoolManager Swap
 * event (lib/v4Swap).
 */
import { describe, expect, it } from "vitest";
import { disciplePoolId, hookTradeFromSwap, impactBpsFromSqrt, priceX18FromSqrt, traderIndex } from "../lib/v4Swap";

const Q96 = BigInt(2) ** BigInt(96);
const TOKEN = "0x1000000000000000000000000000000000000001"; // sorts below QUOTE ⇒ token is currency0
const QUOTE = "0x2000000000000000000000000000000000000002";
const ME = "0x9292000000000000000000000000000000000000";

describe("hookTradeFromSwap", () => {
  // price 1 quote per token (sqrtP = 2^96), L = 1e24: a buy pays 1e20 quote (token1) in, gets ~1e20 token0 out gross
  const L = BigInt(10) ** BigInt(24);
  const paid = BigInt(10) ** BigInt(20);
  const sa = Q96 + (paid * Q96) / L; // price up
  const grossOut = BigInt("99990000999900009999"); // ≈ paid at ~1.0001 average

  it("buy: net tokens = gross − 1%, quote = paid, price before rebuilt from the token1 delta", () => {
    const a = hookTradeFromSwap({ amount0: grossOut, amount1: -paid, sqrtPriceX96: sa, liquidity: L }, TOKEN, QUOTE, ME);
    expect(a.isBuy).toBe(true);
    expect(a.quoteAmt).toBe(paid);
    expect(a.tokenAmt).toBe(grossOut - grossOut / BigInt(100));
    expect(a.sqrtPriceAfter).toBe(sa);
    expect(a.priceBeforeX18).toBe(priceX18FromSqrt(Q96, true));
    expect(a.priceAfterX18 > a.priceBeforeX18).toBe(true);
    expect(a.impactBps).toBe(impactBpsFromSqrt(Q96, sa, true));
    expect(Number(a.impactBps)).toBeGreaterThan(0);
    expect(a.trader).toBe(ME);
    // fee charged in token, reported in quote at the after price (≈ 1% of the quote paid)
    expect(Number(a.fee) / Number(paid)).toBeCloseTo(0.01, 3);
  });

  it("sell: net quote = gross − 1%, tokens = sold", () => {
    const sold = BigInt(10) ** BigInt(20);
    const gross = BigInt("99990000999900009999");
    const after = Q96 - (gross * Q96) / L;
    const a = hookTradeFromSwap({ amount0: -sold, amount1: gross, sqrtPriceX96: after, liquidity: L }, TOKEN, QUOTE, ME);
    expect(a.isBuy).toBe(false);
    expect(a.tokenAmt).toBe(sold);
    expect(a.quoteAmt).toBe(gross - gross / BigInt(100));
    expect(a.fee).toBe(gross / BigInt(100));
    expect(a.priceAfterX18 < a.priceBeforeX18).toBe(true);
  });

  it("token as currency1 flips the sides", () => {
    const a = hookTradeFromSwap({ amount0: -paid, amount1: grossOut, sqrtPriceX96: Q96, liquidity: L }, QUOTE, TOKEN, ME);
    expect(a.isBuy).toBe(true);
    expect(a.quoteAmt).toBe(paid);
  });
});

describe("pool id + trader", () => {
  it("pool id is order-independent", () => {
    const hook = "0x00000000000000000000000000000000000000c1";
    expect(disciplePoolId(TOKEN, QUOTE, hook)).toBe(disciplePoolId(QUOTE, TOKEN, hook));
    expect(disciplePoolId(TOKEN, QUOTE, hook)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("traderIndex picks the router event of the same tx, token and side", () => {
    const who = traderIndex([
      { tx: "0xAA", trader: "0xseller", token: TOKEN, isBuy: false },
      { tx: "0xaa", trader: "0xbuyer", token: TOKEN, isBuy: true },
    ]);
    expect(who("0xaa", TOKEN, true)).toBe("0xbuyer");
    expect(who("0xAA", TOKEN, false)).toBe("0xseller");
    expect(who("0xbb", TOKEN, true)).toBeUndefined();
  });
});

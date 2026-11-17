import { describe, expect, it } from "vitest";
import { clampSlippage, suggestedSessionMax, SESSION_SLIPPAGE_LIMIT_BPS, sessionWindowMinOut } from "../lib/aa/slippage";
import { clampSlippageBps, parseSlippagePctInput, SLIPPAGE_MAX_BPS } from "../lib/aa/session";
import { MAX_SLIPPAGE_PCT, sanitize, slippageBps } from "../lib/trade/swapSettings";
import { tradeMinOut } from "../lib/trade/queuePricing";

const q = 10n ** 18n;
const mid = { lo: q, hi: q };

describe("custom slippage up to 100% (lee, Nov 16 2026)", () => {
  it("accepts 75% and 100% in swap settings, and does not clamp them to 50%", () => {
    expect(MAX_SLIPPAGE_PCT).toBe(100);
    expect(slippageBps(sanitize({ slippage: { mode: "custom", pct: 75 } }))).toBe(7500);
    expect(slippageBps(sanitize({ slippage: { mode: "custom", pct: 100 } }))).toBe(10_000);
    expect(sanitize({ slippage: { mode: "custom", pct: 75 } }).slippage.pct).toBe(75);
    expect(sanitize({ slippage: { mode: "custom", pct: 100 } }).slippage.pct).toBe(100);
  });

  it("clamps only values above 100%", () => {
    expect(sanitize({ slippage: { mode: "custom", pct: 101 } }).slippage.pct).toBe(100);
    expect(slippageBps(sanitize({ slippage: { mode: "custom", pct: 150 } }))).toBe(10_000);
  });

  it("accepts 75% and 100% as a typed max price move", () => {
    expect(SLIPPAGE_MAX_BPS).toBe(10_000);
    expect(clampSlippageBps(7500)).toBe(7500);
    expect(clampSlippageBps(10_000)).toBe(10_000);
    expect(parseSlippagePctInput("75")).toBe(7500);
    expect(parseSlippagePctInput("100%")).toBe(10_000);
    expect(parseSlippagePctInput("12.5")).toBe(1250);
    expect(clampSlippageBps(10_001)).toBe(10_000);
    expect(parseSlippagePctInput("150")).toBe(10_000);
  });

  it("prices a 75% and a 100% trade looser than a 50% trade, and never sends minOut 0", () => {
    const at50 = tradeMinOut(mid, 5000, 5000);
    const at75 = tradeMinOut(mid, 7500, 7500);
    const at100 = tradeMinOut(mid, 10_000, 10_000);
    expect(at75).toBeLessThan(at50);
    expect(at100).toBeLessThan(at75);
    expect(at100).toBe(1n);
    expect(sessionWindowMinOut(q, q, 7500)).toBe(q / 2n);
    expect(sessionWindowMinOut(q, q, 10_000)).toBe(0n);
  });

  it("still caps a real session at the policy's 50% when the player asks for more", () => {
    expect(SESSION_SLIPPAGE_LIMIT_BPS).toBe(5000);
    const c = clampSlippage(7500, 5000);
    expect(c.bps).toBe(4950);
    expect(c.capped).toBe(true);
    expect(suggestedSessionMax(clampSlippage(10_000, 5000))).toBe(5000);
    // no session: a 75% or 100% request is passed through
    expect(clampSlippage(7500, null).bps).toBe(7500);
    expect(clampSlippage(10_000, null).capped).toBe(false);
    expect(clampSlippage(10_000, null).bps).toBe(10_000);
  });
});

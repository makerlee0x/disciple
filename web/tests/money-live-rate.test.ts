/**
 * Money flow: the USDG-per-ETH rate the browser uses for gas reserves (lib/gas/liveRate). Players hold USDG only, so every
 * gas reserve is priced in USDG: the last live rate a gasless quote returned, else the config fallback for one read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GAS } from "../lib/config";

const load = async () => { vi.resetModules(); return import("../lib/gas/liveRate"); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("usdgPerEthRate", () => {
  it("before any quote: the config price (GAS.ethUsd) at the asked decimals", async () => {
    const m = await load();
    expect(m.usdgPerEthRate(6)).toBe(BigInt(Math.round(GAS.ethUsd * 1e6)));
    expect(m.usdgPerEthRate(18)).toBe(BigInt(Math.round(GAS.ethUsd * 1e6)) * BigInt(10) ** BigInt(12));
  });

  it("after a quote: that live rate, rescaled to other decimals both ways", async () => {
    const m = await load();
    m.rememberUsdgPerEth(BigInt(3_123_450_000), 6); // $3,123.45
    expect(m.usdgPerEthRate(6)).toBe(BigInt(3_123_450_000));
    expect(m.usdgPerEthRate(8)).toBe(BigInt(312_345_000_000));
    expect(m.usdgPerEthRate(2)).toBe(BigInt(312_345));
  });

  it("a zero or junk rate is ignored", async () => {
    const m = await load();
    m.rememberUsdgPerEth(BigInt(0), 6);
    m.rememberUsdgPerEth(BigInt(5), Number.NaN);
    expect(m.usdgPerEthRate(6)).toBe(BigInt(Math.round(GAS.ethUsd * 1e6)));
  });

  it("a rate older than 10 minutes falls back to config (and never reuses a stale price)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = await load();
    m.rememberUsdgPerEth(BigInt(9_000_000_000), 6);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect(m.usdgPerEthRate(6)).toBe(BigInt(Math.round(GAS.ethUsd * 1e6)));
  });
});

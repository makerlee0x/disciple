import { describe, it, expect, beforeEach } from "vitest";
import { feeFloor, FEE_SLACK_BPS, liveRateCache, liveUsdgPerEth } from "../lib/server/usdgEthRate";

/** maker 2026-11-19: "eth isnt a fixed price". The pool price is live; the env rate is only the no-pool fallback. */
describe("live USDG per ETH", () => {
  beforeEach(() => liveRateCache.clear());
  it("falls back to the env rate where there is no refill pool (testnet)", async () => {
    expect(await liveUsdgPerEth({ PAYMASTER_USD_PER_ETH: "3100" } as unknown as NodeJS.ProcessEnv)).toBe(3_100_000_000n);
  });
  it("caches for a minute", async () => {
    const a = await liveUsdgPerEth({ PAYMASTER_USD_PER_ETH: "3100" } as unknown as NodeJS.ProcessEnv, 1_000);
    const b = await liveUsdgPerEth({ PAYMASTER_USD_PER_ETH: "9999" } as unknown as NodeJS.ProcessEnv, 30_000);
    expect(b).toBe(a);
    expect(await liveUsdgPerEth({ PAYMASTER_USD_PER_ETH: "9999" } as unknown as NodeJS.ProcessEnv, 70_000)).toBe(9_999_000_000n);
  });
  it("feeFloor allows the slack, no more", () => {
    expect(FEE_SLACK_BPS).toBe(300n);
    expect(feeFloor(10_000n)).toBe(9_700n);
  });
});

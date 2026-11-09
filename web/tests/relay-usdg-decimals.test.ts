// Item e (#115): USDG decimals come from the token once (cached), not a hard-coded 6; no per-trade RPC.
import { afterEach, describe, expect, it } from "vitest";
import { deployment } from "../lib/chains";
import { knownDecimals, resetUsdgDecimalsCache, setUsdgDecimalsOnchain, usdgDecimals, usdToUsdgRaw, usdgRawToUsd } from "../lib/usdg";
import { PaymasterCapCache } from "../lib/aa/gasReserve";
import { needUsdFromUsdg } from "../lib/flight/tradeGate";

const d = deployment();
function fakePc(dec: number) {
  const reads: string[] = [];
  return { reads, pc: { readContract: async (a: { address: string; functionName: string }) => { reads.push(a.functionName); return a.functionName === "decimals" ? dec : 1_000_000n; } } };
}
afterEach(() => resetUsdgDecimalsCache());

describe("USDG decimals: read once, cached, used by every conversion", () => {
  it("config until the token is read", () => {
    expect(usdgDecimals()).toBe(d.usdgDecimals);
    expect(knownDecimals(d.usdg)).toBe(d.usdgDecimals);
  });
  it("the paymaster cap warm-up's decimals() read (already made) sets the cache; later trades do no RPC", async () => {
    const other = d.usdgDecimals === 6 ? 18 : 6, f = fakePc(other), caps = new PaymasterCapCache();
    await caps.warm(f.pc as never, d.paymaster, d.usdg);
    await caps.warm(f.pc as never, d.paymaster, d.usdg);
    expect(f.reads.filter((r) => r === "decimals").length).toBe(1);
    expect(usdgDecimals()).toBe(other);
    expect(knownDecimals(d.usdg)).toBe(other);
    expect(usdToUsdgRaw(1.5)).toBe(15n * 10n ** BigInt(other - 1));
    expect(usdgRawToUsd(10n ** BigInt(other))).toBe(1);
    for (let i = 0; i < 50; i++) usdToUsdgRaw(0.2);   // "trades"
    expect(f.reads.filter((r) => r === "decimals").length).toBe(1);
  });
  it("ignores another token and nonsense values; an explicit deployment is used as given", () => {
    setUsdgDecimalsOnchain("0x00000000000000000000000000000000000000ff", 9);
    setUsdgDecimalsOnchain(d.usdg, 99); setUsdgDecimalsOnchain(d.usdg, -1);
    expect(usdgDecimals()).toBe(d.usdgDecimals);
    setUsdgDecimalsOnchain(d.usdg, 8);
    expect(usdgDecimals({ usdgDecimals: 6 })).toBe(6);
    expect(knownDecimals(d.usdg, { usdg: d.usdg, usdgDecimals: 18, defaultQuote: d.defaultQuote })).toBe(18);
  });
  it("graduation need: decimals are required (no 6 default)", () => {
    expect(needUsdFromUsdg(2_500_000n, 6)).toBeCloseTo(2.5);
    expect(needUsdFromUsdg(25n * 10n ** 17n, 18)).toBeCloseTo(2.5);
  });
});

/** Pumped launch price flag (audit 2026-11-21): judge + cached set. */
import { describe, expect, it } from "vitest";
import { judgeLaunchPrice, pumpedCached, pumpedLaunchSet } from "../lib/server/launchPriceCheck";

const E18 = 10n ** 18n;
function memKv() {
  const m = new Map<string, string>();
  return { m, s: { get: async (k: string) => m.get(k) ?? null, mget: async (ks: string[]) => ks.map((k) => m.get(k) ?? null), set: async (k: string, v: string) => { m.set(k, v); },
    setNX: async (k: string, v: string) => { if (m.has(k)) return false; m.set(k, v); return true; } } as never };
}

describe("judgeLaunchPrice", () => {
  it("flags only when the baked price is >10% off the market both before and after the launch block", () => {
    expect(judgeLaunchPrice(10n * E18, E18, E18)).toBe("pumped");        // 10x pump, unwound in the same tx
    expect(judgeLaunchPrice(E18 + E18 / 20n, E18, E18)).toBe("ok");       // honest First BOOST impact (~5%)
    expect(judgeLaunchPrice(E18 / 5n, E18, E18)).toBe("pumped");          // pushed down 5x
    expect(judgeLaunchPrice(2n * E18, E18, 2n * E18)).toBe("ok");         // the market really moved in that block
    expect(judgeLaunchPrice(10n * E18, null, null)).toBe("unknown");      // RPC couldn't serve the old state
    expect(judgeLaunchPrice(10n * E18, null, E18)).toBe("pumped");
  });
});

describe("pumpedLaunchSet", () => {
  const coin = (n: number) => ({ token: `0x${n.toString(16).padStart(40, "0")}`, curve: `0x${(n + 100).toString(16).padStart(40, "0")}`, quote: "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18", block: 100n });
  it("checks new coins once, caches the verdict, and the XP path reads only the cache", async () => {
    const { m, s } = memKv();
    let reads = 0;
    const pc = { readContract: async (a: { functionName: string; address: string }) => {
      reads++;
      if (a.functionName === "quotePriceUsd") return a.address.endsWith("65") ? 10n * E18 : E18; // coin 1's curve (0x…65) baked 10x
      return E18;
    } } as never;
    const set = await pumpedLaunchSet(pc, [coin(1), coin(2)], 25, s);
    expect([...set]).toEqual([coin(1).token]);
    expect([...m.values()].sort()).toEqual(["ok", "pumped"]);
    const before = reads;
    expect([...(await pumpedLaunchSet(pc, [coin(1), coin(2)], 25, s))]).toEqual([coin(1).token]);
    expect(reads).toBe(before);   // cached: no chain reads
    expect([...(await pumpedCached([coin(1).token.toUpperCase().replace("0X", "0x"), coin(2).token], s))]).toEqual([coin(1).token]);
  });
});

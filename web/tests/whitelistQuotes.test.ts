import { describe, expect, it } from "vitest";
import { OPTIONAL_QUOTES, WHITELIST_QUOTES, whitelistQuoteByAddress, whitelistQuoteBySymbol } from "../lib/whitelistQuotes";
import { buildLaunchWhitelist, LAUNCH_WHITELIST, whitelistIncludesUsdg } from "../lib/launchWhitelist";

describe("whitelist quotes", () => {
  it("lists the 12 launch coins (Nov 16 2026)", () => {
    expect(WHITELIST_QUOTES.map((q) => q.symbol)).toEqual([
      "STRATEGY", "AI", "SCHIFFY", "BONER", "MEME", "PONS", "ORBIO", "HOOKR", "CASHCAT", "PRIORS", "PENGU", "HMM",
    ]);
    expect(whitelistQuoteBySymbol("PENGU")?.address).toBe("0x74BE72AFFAFbC8de30F0C11247814036314D625f");
    expect(whitelistQuoteByAddress("0x7fe995a80075df3dc8ae11a9b82c7fe4202cd87f")?.symbol).toBe("HMM");
  });

  it("gives each coin a 256 image path, 18 decimals, and a 0x address", () => {
    for (const q of WHITELIST_QUOTES) {
      expect(q.decimals).toBe(18);
      expect(q.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(q.imagePath).toBe(`/whitelist/${q.symbol}.png`);
      expect(q.name.length).toBeGreaterThan(0);
    }
  });

  it("keeps USDG and ETH off the launch list unless switched on", () => {
    expect(OPTIONAL_QUOTES.map((q) => q.symbol)).toEqual(["USDG", "ETH"]);
    expect(LAUNCH_WHITELIST).toHaveLength(12);
    expect(whitelistIncludesUsdg(LAUNCH_WHITELIST)).toBe(false);
    expect(buildLaunchWhitelist({ USDG: true }).map((c) => c.symbol)).toContain("USDG");
    expect(buildLaunchWhitelist({ ETH: true }).map((c) => c.symbol).slice(-1)).toEqual(["ETH"]);
  });
});

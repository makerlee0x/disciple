import { describe, expect, it } from "vitest";
import { OPTIONAL_QUOTES, WHITELIST_QUOTES, whitelistQuoteByAddress, whitelistQuoteBySymbol } from "../lib/whitelistQuotes";
import { buildLaunchWhitelist, LAUNCH_WHITELIST, whitelistIncludesUsdg } from "../lib/launchWhitelist";

describe("whitelist quotes", () => {
  it("lists the 12 launch coins (Nov 16 2026)", () => {
    expect(WHITELIST_QUOTES.map((q) => q.symbol)).toEqual([
      "STRATEGY", "AI", "SCHIFFY", "BONER", "MEME", "PONS", "ORBIO", "HOOKR", "CASHCAT", "PRIORS", "PENGU", "DELTA",
    ]);
    expect(whitelistQuoteBySymbol("PENGU")?.address).toBe("0x74BE72AFFAFbC8de30F0C11247814036314D625f");
    expect(whitelistQuoteByAddress("0xe8ffd7e24187f72afb08d75b1bb13088a989a791")?.symbol).toBe("DELTA");
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

describe("base pair on rocket cards (maker 2026-11-19)", () => {
  it("names a whitelisted quote by its symbol and gives its logo", async () => {
    const { pairSymOf, pairLogoSrc, isNamedPair } = await import("../lib/home/pairs");
    expect(pairSymOf(whitelistQuoteBySymbol("PENGU")!.address.toLowerCase())).toBe("PENGU");
    expect(pairSymOf("0x1234567890123456789012345678901234567890")).toMatch(/^0x1234…/);
    expect(pairLogoSrc("SCHIFFY")).toBe("/whitelist/SCHIFFY.png");
    expect(pairLogoSrc("mUSDG")).toBe("/whitelist/USDG.png");
    expect(isNamedPair("0x1234…7890")).toBe(false);
  });
});

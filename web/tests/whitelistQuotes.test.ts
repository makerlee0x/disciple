import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  OPTIONAL_QUOTES, TESTNET_PAIR_QUOTES, TESTNET_STAND_INS, WHITELIST_QUOTES, whitelistQuoteByAddress, whitelistQuoteBySymbol,
} from "../lib/whitelistQuotes";
import { addressOn, buildLaunchWhitelist, coinByAddress, LAUNCH_WHITELIST, launchPairsForChain, whitelistIncludesUsdg } from "../lib/launchWhitelist";
import { MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from "../lib/networkConfig";

describe("whitelist quotes", () => {
  it("lists the 12 launch coins (Nov 16 2026)", () => {
    expect(WHITELIST_QUOTES.map((q) => q.symbol)).toEqual([
      "STRATEGY", "AI", "SCHIFFY", "BONER", "MEME", "MOO", "PONS", "ORBIO", "HOOKR", "CASHCAT", "PRIORS", "PENGU",
    ]);
    expect(whitelistQuoteBySymbol("PENGU")?.address).toBe("0x74BE72AFFAFbC8de30F0C11247814036314D625f");
    expect(whitelistQuoteByAddress("0xd9db30bb0d2b8d2eae3826a1372117e058791e18")?.symbol).toBe("MOO");
    expect(whitelistQuoteBySymbol("HMM")).toBeUndefined();
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

  it("keeps the mainnet pair list exactly as is", () => {
    expect(launchPairsForChain(MAINNET_CHAIN_ID).map((c) => [c.symbol, c.address])).toEqual(
      WHITELIST_QUOTES.map((q) => [q.symbol, q.address]),
    );
    expect(launchPairsForChain(MAINNET_CHAIN_ID).some((c) => c.symbol === "HMM")).toBe(false);
  });

  it("offers STRATEGY and the 11 stand-ins on testnet (no HMM), each with a testnet address and an image", () => {
    const testQuote = "0xF5eB226F7f0890c36A06Cbd0Ff843292b7b1a88C" as const;
    const list = launchPairsForChain(TESTNET_CHAIN_ID);
    expect(list.map((c) => c.symbol)).toEqual([
      "STRATEGY", "AI", "SCHIFFY", "BONER", "MEME", "MOO", "PONS", "ORBIO", "HOOKR", "CASHCAT", "PRIORS", "PENGU",
    ]);
    expect(list.some((c) => c.symbol === "HMM")).toBe(false);
    expect(addressOn(list[0], TESTNET_CHAIN_ID, testQuote)).toBe(testQuote);
    const mainnet = new Set(WHITELIST_QUOTES.map((q) => q.address.toLowerCase()));
    for (const c of list.slice(1)) {
      expect(c.address).toBe(TESTNET_STAND_INS[c.symbol]);
      expect(c.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(mainnet.has(c.address.toLowerCase())).toBe(false);
      expect(addressOn(c, TESTNET_CHAIN_ID, testQuote)).toBe(c.address);
      expect(c.decimals).toBe(18);
      expect(c.image).toBe(`/whitelist/${c.symbol}.png`);
      expect(existsSync(join(__dirname, "..", "public", c.image))).toBe(true);
    }
    expect(TESTNET_PAIR_QUOTES).toHaveLength(11);
    expect(coinByAddress(TESTNET_STAND_INS.PENGU.toLowerCase(), TESTNET_CHAIN_ID, testQuote)?.symbol).toBe("PENGU");
    expect(coinByAddress(TESTNET_STAND_INS.PENGU, MAINNET_CHAIN_ID, testQuote)).toBeUndefined();
  });
});

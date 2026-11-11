import { describe, expect, it } from "vitest";
import { WHITELIST_QUOTES, whitelistQuoteByAddress, whitelistQuoteBySymbol } from "../lib/whitelistQuotes";

describe("whitelist quotes", () => {
  it("lists 12 coins and does not include BUN", () => {
    expect(WHITELIST_QUOTES).toHaveLength(12);
    expect(WHITELIST_QUOTES.map((q) => q.symbol)).not.toContain("BUN");
    expect(whitelistQuoteBySymbol("SPACEHOOD")?.address).toBe(
      "0xFe7E19CbCe2f896C6C528BC355bAF5a768291E18",
    );
    expect(whitelistQuoteByAddress("0xfe7e19cbce2f896c6c528bc355baf5a768291e18")?.symbol).toBe("SPACEHOOD");
  });

  it("gives each coin a 256 image path, 18 decimals, and a 0x address", () => {
    for (const q of WHITELIST_QUOTES) {
      expect(q.decimals).toBe(18);
      expect(q.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(q.imagePath).toBe(`/whitelist/${q.symbol}.png`);
      expect(q.name.length).toBeGreaterThan(0);
    }
  });
});

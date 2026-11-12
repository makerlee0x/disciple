/**
 * The gasless router must not appear as a player in the TRADES feed or the Holders list.
 * Trades stay recorded (the chart still gets the fill); only display lists hide it.
 */
import { describe, expect, it } from "vitest";
import { isHiddenTrader, HIDDEN_TRADERS } from "../lib/home/hiddenCoins";
import { rankHolders } from "../lib/holders";
import { defaultUsername } from "../lib/defaultUsername";

const ROUTER = "0x0C21C3B9bb01A8245Cd6B9659c727aFfACC46D7e";
const USER = "0x6db02C11D1fDf6B60B5796dfF0285DD71Dfad9A3";
const REGULAR = "0x688160633b22012717661545df6299d3d3174ad2"; // USDG DiscipleRouter; hook-trusted, not a recorded trader

describe("hidden traders (gasless router)", () => {
  it("hides the gasless DiscipleRouter and hashes it to Maverick Skyrocket", () => {
    expect(isHiddenTrader(ROUTER)).toBe(true);
    expect(isHiddenTrader(ROUTER.toLowerCase())).toBe(true);
    expect(HIDDEN_TRADERS.has(ROUTER.toLowerCase())).toBe(true);
    expect(defaultUsername(ROUTER)).toBe("Maverick Skyrocket");
  });

  it("does not hide a real user or the hook-trusted USDG router", () => {
    expect(isHiddenTrader(USER)).toBe(false);
    expect(isHiddenTrader(REGULAR)).toBe(false);
  });

  it("rankHolders omits the gasless router even when it holds a balance (fail-before / pass-after)", () => {
    const h = rankHolders(
      { [ROUTER.toLowerCase()]: "1000", [USER.toLowerCase()]: "500" },
      { totalSupply: 1500n, mcapUsd: 1500, labels: {}, limit: 10 },
    );
    expect(h.map((r) => r.address)).toEqual([USER.toLowerCase()]);
    expect(h.some((r) => r.address === ROUTER.toLowerCase())).toBe(false);
  });
});

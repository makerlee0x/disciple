/**
 * Legacy coins hidden from app lists (lib/home/hiddenCoins). Direct /coin/<address> URLs still resolve.
 * Older-stack Easy test coins whose curves still check LoginGate on-chain (buys revert NotVerified) are
 * hidden here. The gasless path no longer pre-refuses any coin. GAME TEST NEAR is also hidden (legacy-tagged trench near graduation).
 */
import { describe, expect, it } from "vitest";
import { isHiddenCoin } from "../lib/home/hiddenCoins";

/** Older-stack Easy coins on launchpad 0x8a92… whose curves still check LoginGate on-chain. */
export const LEGACY_LOGIN_GATE_COINS = [
  "0x758a61c27bdd1b18e5a31fc3cc04b400fc95d4a3", // Velvet Dragon (VELVET)
  "0xf48aa293d5c281fb3ede2598641a264f5f579315", // Velvet Dragon (VELVET)
  "0x56262d587fdca44f8ea1cd2eb807836cfc8f9b07", // Velvet Dragon (VELVET)
  "0x6efd87cf06fc304bc1011f9f5d3f744cf4767aff", // Velvet Dragon (VELVET)
] as const;

/** GAME TEST NEAR — UI-legacy trench (loginGate = 0), gasless ascension fails (900k gas cap). */
export const GTNEAR = "0x443cbf068a02809cbcbd76d91a898e423a8eb1e9";

describe("hiddenCoins: legacy gasless refusals", () => {
  it("hides every older-stack Easy test coin (curve still checks LoginGate)", () => {
    for (const token of LEGACY_LOGIN_GATE_COINS) {
      expect(isHiddenCoin(token), token).toBe(true);
      expect(isHiddenCoin(token.toUpperCase()), "checksum case").toBe(true);
    }
  });

  it("hides GAME TEST NEAR (GTNEAR) from lists", () => {
    expect(isHiddenCoin(GTNEAR)).toBe(true);
  });

  it("does not hide GAME TEST FRESH (still used for testing)", () => {
    expect(isHiddenCoin("0xab9e86498c9b32743e31b0fca02d6b254bcddd4e")).toBe(false);
  });
});

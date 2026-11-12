import { afterEach, describe, expect, it, vi } from "vitest";
import { clientGaslessMode, clientSelfBundlerMode, clientSponsorshipMode, resolveSponsorshipMode } from "../lib/aa/sponsorshipMode";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("gasless is the only resolved mode in every environment", () => {
  it("defaults to gasless when no sponsorship variable is set", () => { expect(resolveSponsorshipMode({})).toBe("gasless"); });
  it("defaults to gasless in production, preview, and development", () => {
    for (const env of ["production", "preview", "development"]) {
      expect(resolveSponsorshipMode({ VERCEL_ENV: env })).toBe("gasless");
      expect(resolveSponsorshipMode({ NEXT_PUBLIC_VERCEL_ENV: env })).toBe("gasless");
    }
  });
  it("maps leftover explicit self/bso/hosted (and typo) values to gasless", () => {
    for (const mode of ["self", "bso", "hosted", "typo", "gasless"]) {
      expect(resolveSponsorshipMode({ GAS_SPONSORSHIP_MODE: mode })).toBe("gasless");
      expect(resolveSponsorshipMode({ VERCEL_ENV: "production", GAS_SPONSORSHIP_MODE: mode })).toBe("gasless");
    }
    expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "1" })).toBe("gasless");
    expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "0" })).toBe("gasless");
  });
  it("browser bootstrap, including Production, resolves to gasless", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    for (const mode of ["self", "bso", "hosted", "gasless"]) {
      vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode }) }) });
      expect(clientSponsorshipMode()).toBe("gasless");
      expect(clientGaslessMode()).toBe(true);
      expect(clientSelfBundlerMode()).toBe(false);
    }
    vi.stubGlobal("document", { getElementById: () => ({ textContent: "" }) });
    expect(clientSponsorshipMode()).toBe("gasless");
    expect(clientGaslessMode()).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { clientGaslessMode, clientSelfBundlerMode, clientSponsorshipMode, resolveSponsorshipMode } from "../lib/aa/sponsorshipMode";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("gasless is the default in every environment", () => {
  it("defaults to gasless when no sponsorship variable is set", () => { expect(resolveSponsorshipMode({})).toBe("gasless"); });
  it("defaults to gasless in production, preview, and development", () => {
    for (const env of ["production", "preview", "development"]) {
      expect(resolveSponsorshipMode({ VERCEL_ENV: env })).toBe("gasless");
      expect(resolveSponsorshipMode({ NEXT_PUBLIC_VERCEL_ENV: env })).toBe("gasless");
    }
  });
  it("the leftover AA_SELF_BUNDLER switch no longer selects a mode", () => {
    expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "1" })).toBe("gasless");
    expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "0" })).toBe("gasless");
    expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "0", GAS_SPONSORSHIP_MODE: "self" })).toBe("self");
  });
  it("still recognizes explicit leftover self/bso/hosted values (switch kept)", () => {
    expect(resolveSponsorshipMode({ GAS_SPONSORSHIP_MODE: "self" })).toBe("self");
    expect(resolveSponsorshipMode({ GAS_SPONSORSHIP_MODE: "bso" })).toBe("bso");
    expect(resolveSponsorshipMode({ GAS_SPONSORSHIP_MODE: "hosted" })).toBe("hosted");
    expect(resolveSponsorshipMode({ VERCEL_ENV: "production", GAS_SPONSORSHIP_MODE: "self" })).toBe("self");
    expect(resolveSponsorshipMode({ VERCEL_ENV: "production", GAS_SPONSORSHIP_MODE: "bso" })).toBe("bso");
  });
  it("an unknown explicit mode falls through to the gasless default", () => { expect(resolveSponsorshipMode({ GAS_SPONSORSHIP_MODE: "typo" })).toBe("gasless"); });
  it("learns the server mode from non-secret bootstrap without a NEXT_PUBLIC mode variable", () => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_MODE", ""); vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
    vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode: "self" }) }) });
    expect(clientSelfBundlerMode()).toBe(true);
    expect(clientSponsorshipMode()).toBe("self");
  });
  it("server BSO selection reaches the client, rather than silently choosing gasless", () => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_MODE", "gasless");
    vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode: "bso" }) }) });
    expect(clientSponsorshipMode()).toBe("bso"); expect(clientSelfBundlerMode()).toBe(false);
  });
  it("missing/malformed browser bootstrap defaults to gasless, not a 4337 path", () => {
    for (const textContent of ["", "not json"]) {
      vi.stubGlobal("document", { getElementById: () => ({ textContent }) });
      expect(clientSponsorshipMode()).toBe("gasless");
      expect(clientSelfBundlerMode()).toBe(false);
      expect(clientGaslessMode()).toBe(true);
    }
  });
  it("a Production browser defaults to gasless and still honors an explicit bootstrap", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubGlobal("document", { getElementById: () => ({ textContent: "" }) });
    expect(clientSponsorshipMode()).toBe("gasless");
    expect(clientGaslessMode()).toBe(true);
    vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode: "self" }) }) });
    expect(clientSponsorshipMode()).toBe("self");
  });
});

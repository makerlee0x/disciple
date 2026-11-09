import { afterEach, describe, expect, it, vi } from "vitest";
import { clientSelfBundlerMode, clientSponsorshipMode, resolveSponsorshipMode } from "../lib/aa/sponsorshipMode";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("unchanged Preview environment mode selection", () => {
  it("defaults this test branch to self without either introduced variable", () => { expect(resolveSponsorshipMode({})).toBe("self"); });
  it("honors the legacy self switch and its explicit off value", () => {
    expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "1" })).toBe("self");
    expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "0" })).toBe("hosted");
    expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "0", GAS_SPONSORSHIP_MODE: "self" })).toBe("hosted");
  });
  it("keeps explicit BSO selectable even with the legacy self switch", () => { expect(resolveSponsorshipMode({ AA_SELF_BUNDLER: "1", GAS_SPONSORSHIP_MODE: "bso" })).toBe("bso"); });
  it("never enables self or BSO for Production", () => {
    for (const mode of ["self", "bso"]) expect(resolveSponsorshipMode({ VERCEL_ENV: "production", GAS_SPONSORSHIP_MODE: mode, AA_SELF_BUNDLER: "1" })).toBe("hosted");
  });
  it("an unknown explicit mode fails closed", () => { expect(resolveSponsorshipMode({ GAS_SPONSORSHIP_MODE: "typo" })).toBe("hosted"); });
  it("learns the server mode from non-secret bootstrap without a NEXT_PUBLIC mode variable", () => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_MODE", ""); vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
    vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode: "self" }) }) });
    expect(clientSelfBundlerMode()).toBe(true);
  });
  it("server BSO selection reaches the client, rather than silently choosing self", () => {
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_MODE", "self");
    vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode: "bso" }) }) });
    expect(clientSponsorshipMode()).toBe("bso"); expect(clientSelfBundlerMode()).toBe(false);
  });
  it("missing/malformed/wrong-chain browser bootstrap cannot authorize self", () => {
    for (const textContent of ["", "not json", JSON.stringify({ chainId: 1, mode: "self" })]) {
      vi.stubGlobal("document", { getElementById: () => ({ textContent }) }); expect(clientSelfBundlerMode()).toBe(false);
    }
  });
  it("a Production browser ignores a self bootstrap", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode: "self" }) }) });
    expect(clientSelfBundlerMode()).toBe(false);
  });
});

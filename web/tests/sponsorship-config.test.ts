import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.NEXT_PUBLIC_CHAIN_ID = "46630"; });
import { GET } from "../app/api/aa/config/route";
afterEach(() => vi.unstubAllEnvs());
it("Preview publishes only chain and resolved mode using its existing legacy switch", async () => {
  vi.stubEnv("GAS_SPONSORSHIP_MODE", ""); vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_MODE", "");
  vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("AA_SELF_BUNDLER", "1");
  const response = GET(); expect(await response.json()).toEqual({ chainId: 46630, mode: "self" });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("the same public configuration can select hosted BSO without exposing credentials", async () => {
  vi.stubEnv("GAS_SPONSORSHIP_MODE", "bso"); vi.stubEnv("VERCEL_ENV", "preview");
  expect(await GET().json()).toEqual({ chainId: 46630, mode: "bso" });
});
it("Production never publishes a self-relay opt-in", async () => {
  vi.stubEnv("GAS_SPONSORSHIP_MODE", "self"); vi.stubEnv("VERCEL_ENV", "production");
  expect(await GET().json()).toEqual({ chainId: 46630, mode: "hosted" });
});

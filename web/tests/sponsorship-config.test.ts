import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.NEXT_PUBLIC_CHAIN_ID = "46630"; });
import { GET } from "../app/api/aa/config/route";
afterEach(() => vi.unstubAllEnvs());
it("Preview publishes gasless when no sponsorship variable is set", async () => {
  vi.stubEnv("GAS_SPONSORSHIP_MODE", ""); vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_MODE", "");
  vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("AA_SELF_BUNDLER", "1");
  const response = GET(); expect(await response.json()).toEqual({ chainId: 46630, mode: "gasless" });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("the same public configuration can still select leftover explicit modes without exposing credentials", async () => {
  vi.stubEnv("GAS_SPONSORSHIP_MODE", "bso"); vi.stubEnv("VERCEL_ENV", "preview");
  expect(await GET().json()).toEqual({ chainId: 46630, mode: "bso" });
});
it("Production publishes gasless by default, including when a leftover self env is not set", async () => {
  vi.stubEnv("GAS_SPONSORSHIP_MODE", ""); vi.stubEnv("VERCEL_ENV", "production");
  expect(await GET().json()).toEqual({ chainId: 46630, mode: "gasless" });
});
it("Production still publishes an explicit leftover self value (switch kept until the 4337 path is removed)", async () => {
  vi.stubEnv("GAS_SPONSORSHIP_MODE", "self"); vi.stubEnv("VERCEL_ENV", "production");
  expect(await GET().json()).toEqual({ chainId: 46630, mode: "self" });
});

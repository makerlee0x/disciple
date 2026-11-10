/**
 * startSession used to always fire 4337 warm-ups (warmGasReserve, preparePrepay,
 * maybeAutoOneTap), which hit /api/paymaster and 503 in gasless mode.
 * Fail-before / pass-after: those run only when !clientGaslessMode().
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldWarmAaOnSessionStart, clientGaslessMode, type SponsorshipMode } from "../lib/aa/sponsorshipMode";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("skip 4337 session warm-up in gasless mode", () => {
  it("shouldWarmAaOnSessionStart is false only for gasless (fail-before / pass-after)", () => {
    expect(shouldWarmAaOnSessionStart("gasless")).toBe(false);
    for (const mode of ["self", "bso", "hosted"] as const satisfies readonly SponsorshipMode[]) {
      expect(shouldWarmAaOnSessionStart(mode)).toBe(true);
    }
  });

  it("clientGaslessMode() drives the default: gasless bootstrap skips warm-up, self does not", () => {
    vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode: "gasless" }) }) });
    expect(clientGaslessMode()).toBe(true);
    expect(shouldWarmAaOnSessionStart()).toBe(false);

    vi.stubGlobal("document", { getElementById: () => ({ textContent: JSON.stringify({ chainId: 46630, mode: "self" }) }) });
    expect(clientGaslessMode()).toBe(false);
    expect(shouldWarmAaOnSessionStart()).toBe(true);
  });

  it("startSession only schedules the three 4337 warm-ups behind shouldWarmAaOnSessionStart()", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/aa/session.ts"), "utf8");
    const m = src.match(/async function startSession[\s\S]*?\n  return a;\n\}/);
    expect(m, "startSession not found").toBeTruthy();
    const body = m![0];
    expect(body).toMatch(/if \(shouldWarmAaOnSessionStart\(\)\) \{\s*void sa\.warmGasReserve\(\)\.catch\(\(\) => undefined\);\s*void sa\.preparePrepay\(\)\.catch\(\(\) => undefined\);\s*\}/);
    expect(body).toMatch(/if \(shouldWarmAaOnSessionStart\(\)\) void maybeAutoOneTap\("login"\);/);
    const unguarded = body
      .replace(/if \(shouldWarmAaOnSessionStart\(\)\) \{[\s\S]*?\}/, "")
      .replace(/if \(shouldWarmAaOnSessionStart\(\)\) void maybeAutoOneTap\("login"\);/, "");
    expect(unguarded).not.toMatch(/warmGasReserve|preparePrepay|maybeAutoOneTap/);
  });
});

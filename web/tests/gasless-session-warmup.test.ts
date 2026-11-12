/**
 * After the 4337 path was deleted, startSession must not create a MAv2 account or fire
 * paymaster/one-tap warm-ups (warmGasReserve, preparePrepay, maybeAutoOneTap, makeAccount).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/aa/session.ts"), "utf8");

describe("4337 session warm-ups are gone", () => {
  it("startSession does not build a MAv2 account or call 4337 warm-ups", () => {
    expect(src).toContain("async function startSession");
    expect(src).not.toMatch(/makeAccount|Mav2Account|warmGasReserve|preparePrepay/);
    const start = src.indexOf("async function startSession");
    const body = src.slice(start, src.indexOf("export const oneTapAvailable", start));
    expect(body).not.toMatch(/maybeAutoOneTap|shouldWarmAaOnSessionStart/);
  });
  it("aaSend is no longer a userOp path", () => {
    expect(src).toMatch(/The 4337 trade path has been removed/);
  });
});

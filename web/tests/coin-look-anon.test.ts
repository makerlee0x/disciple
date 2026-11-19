/** maker 2026-11-19: an anon launch lost its launch rocket look. A hidden coin's on-chain creator is the AnonLauncher, so
 *  the stealth owner's signature has to be checked against AnonLauncher.stealthOwnerOf, not Launchpad.creatorOf. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { coinLookMessage } from "@/lib/coinLook";
import { anonLaunchers } from "@/lib/anon";
import { ACTIVE_CHAIN } from "@/lib/chains";

const STEALTH_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const OTHER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const COIN = "0x88e0000000000000000000000000000000030be0";
const launcher = anonLaunchers(ACTIVE_CHAIN.id)[0].toLowerCase();

let mod: typeof import("@/lib/server/coinLooks");
beforeAll(async () => {
  process.env.KV_LOCAL_FILE = join(mkdtempSync(join(tmpdir(), "coinlook-")), "kv.json");
  mod = await import("@/lib/server/coinLooks");
  mod.setCreatorOfForTests(async () => launcher);
  mod.setStealthOwnerOfForTests(async (_t, creator) => (creator === launcher ? privateKeyToAccount(STEALTH_KEY).address.toLowerCase() : null));
});
afterAll(() => { delete process.env.KV_LOCAL_FILE; });

const sign = (key: `0x${string}`, token: string) => privateKeyToAccount(key).signMessage({ message: coinLookMessage(token, "classic", "trail-ice") });

describe("hidden launch look", () => {
  it("someone else's key can't paint a hidden coin", async () => {
    const r = await mod.setCoinLook(COIN, { sig: await sign(OTHER_KEY, COIN) }, "classic", "trail-ice");
    expect(r.ok).toBe(false);
  });
  it("the coin's stealth owner can paint it, once", async () => {
    const r = await mod.setCoinLook(COIN, { sig: await sign(STEALTH_KEY, COIN) }, "classic", "trail-ice");
    expect(r.ok).toBe(true);
    expect((await mod.coinLooksOf([COIN]))[COIN]?.trail).toBe("trail-ice");
    const again = await mod.setCoinLook(COIN, { sig: await sign(STEALTH_KEY, COIN) }, "classic", "trail-ice");
    expect(again.ok).toBe(false);
  });
});

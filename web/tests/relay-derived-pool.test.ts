import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { poolKey, poolNames, uniquePoolNames } from "../lib/server/relayerPool";

const MAIN = "0x" + "11".repeat(32);
/** maker 2026-11-19: relayer keys are derived on the server; nobody makes 16 wallets by hand. */
describe("derived relayer pool", () => {
  it("RELAYER_POOL_SIZE adds that many distinct keys, none equal to the main relayer", () => {
    const env = { RELAYER_PRIVATE_KEY: MAIN, RELAYER_POOL_SIZE: "16" };
    const names = uniquePoolNames(env, poolNames(env));
    expect(names).toHaveLength(16);
    const addrs = new Set(names.map((n) => privateKeyToAccount(poolKey(env, n)!).address));
    expect(addrs.size).toBe(16);
    expect(addrs.has(privateKeyToAccount(MAIN as `0x${string}`).address)).toBe(false);
  });
  it("is stable across instances and changes with the seed", () => {
    const a = poolKey({ RELAYER_PRIVATE_KEY: MAIN, RELAYER_POOL_SIZE: "4" }, "RELAYER_POOL_2");
    expect(poolKey({ RELAYER_PRIVATE_KEY: MAIN, RELAYER_POOL_SIZE: "4" }, "RELAYER_POOL_2")).toBe(a);
    expect(poolKey({ RELAYER_PRIVATE_KEY: MAIN, RELAYER_POOL_SEED: "0x" + "22".repeat(32), RELAYER_POOL_SIZE: "4" }, "RELAYER_POOL_2")).not.toBe(a);
  });
  it("off without a size; never past the size or 32", () => {
    expect(poolNames({ RELAYER_PRIVATE_KEY: MAIN })).toEqual([]);
    expect(poolKey({ RELAYER_PRIVATE_KEY: MAIN, RELAYER_POOL_SIZE: "4" }, "RELAYER_POOL_5")).toBeUndefined();
    expect(poolNames({ RELAYER_PRIVATE_KEY: MAIN, RELAYER_POOL_SIZE: "99" })).toHaveLength(32);
  });
});

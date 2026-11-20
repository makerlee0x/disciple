/** coinsOf keeps only coins this chain's launchpad knows: testnet coins in a wallet's KV set must not reach the Flight log. */
import { describe, expect, it } from "vitest";
import { onThisStack } from "../lib/server/trades";

const MAIN = "0x1111111111111111111111111111111111111111";
const TEST = "0x88e0000000000000000000000000000000000000";
const BAD = "0x28cf000000000000000000000000000000000000";

describe("onThisStack", () => {
  it("drops a coin the launchpad has no curve for", async () => {
    expect(await onThisStack(TEST, async () => "0x0000000000000000000000000000000000000000")).toBe(false);
  });
  it("keeps a coin with a curve", async () => {
    expect(await onThisStack(MAIN, async () => "0x2222222222222222222222222222222222222222")).toBe(true);
  });
  it("keeps the coin when the read fails, and does not cache the failure", async () => {
    expect(await onThisStack(BAD, async () => { throw new Error("rpc down"); })).toBe(true);
    expect(await onThisStack(BAD, async () => "0x0000000000000000000000000000000000000000")).toBe(false);
  });
});

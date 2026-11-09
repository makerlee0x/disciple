import { describe, expect, it } from "vitest";
import { createRelayLoginJoin, installedRelaySession } from "../lib/aa/relayReadiness";
const nonce = (entity: bigint, flags = 0n) => `0x${(((entity << 8n) | flags) << 64n).toString(16)}`;
describe("client relay readiness", () => {
  it("routes installed sessions, not owner/deferred/global/setup operations, to self relay", () => {
    expect(installedRelaySession({ nonce: nonce(7n) })).toBe(true);
    expect(installedRelaySession({ nonce: nonce(7n), factoryData: "0x" })).toBe(true);
    for (const n of [nonce(0n), nonce(7n, 1n), nonce(7n, 2n), nonce(0x80000000n), "bad"])
      expect(installedRelaySession({ nonce: n })).toBe(false);
    expect(installedRelaySession({ nonce: nonce(7n), factory: "0x1234" })).toBe(false);
    expect(installedRelaySession({ nonce: nonce(7n), factoryData: "0x12" })).toBe(false);
  });
  it("dedupes background normal login setup, without caching completion", async () => {
    const join = createRelayLoginJoin(); let count = 0, release: () => void = () => undefined;
    const task = () => { count++; return new Promise<void>(r => { release = r; }); };
    const a = join("0xABC", task), b = join("0xabc", task); expect(a).toBe(b);
    await Promise.resolve(); expect(count).toBe(1); release(); await a;
    await join("0xabc", async () => { count++; }); expect(count).toBe(2);
  });
  it("retries after failed normal login and never joins different accounts", async () => {
    const join = createRelayLoginJoin();
    await expect(join("a", async () => { throw Error("normal auth failed"); })).rejects.toThrow("normal auth failed");
    await expect(join("a", async () => undefined)).resolves.toBeUndefined();
    let a = false, b = false;
    await Promise.all([join("a", async () => { a = true; }), join("b", async () => { b = true; })]);
    expect(a && b).toBe(true);
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ readContract: h.read }) }));
const pm = "0x1111111111111111111111111111111111111111" as const;
beforeEach(() => { vi.resetModules(); h.read.mockReset(); vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });
it("never uses a prefetched value as authority: same TTL/debit-aware getter is reread", async () => {
  const { paymasterDepositCached: read, debitPaymasterDeposit: debit } = await import("../lib/server/paymasterDeposit");
  h.read.mockResolvedValue(1000n); const prefetch = read(pm); expect(await prefetch).toBe(1000n);
  debit(pm, 300n); expect(await read(pm)).toBe(700n); expect(h.read).toHaveBeenCalledOnce();
  vi.setSystemTime(10_001); h.read.mockResolvedValue(500n); expect(await read(pm)).toBe(500n); expect(h.read).toHaveBeenCalledTimes(2);
});
it("failures reject and do not populate the deposit cache", async () => {
  const { paymasterDepositCached: read } = await import("../lib/server/paymasterDeposit");
  h.read.mockRejectedValueOnce(Error("RPC failed")); await expect(read(pm)).rejects.toThrow("RPC failed");
  h.read.mockResolvedValue(4n); expect(await read(pm)).toBe(4n); expect(h.read).toHaveBeenCalledTimes(2);
});
it("overlaps read-only deposit RTT with admission, using real unchanged getter", async () => {
  const run = async (overlap: boolean) => {
    vi.resetModules(); const { paymasterDepositCached: read } = await import("../lib/server/paymasterDeposit");
    h.read.mockImplementation(() => new Promise<bigint>(resolve => setTimeout(() => resolve(1000n), 100)));
    const start = Date.now();
    const work = (async () => { const prefetch = overlap ? read(pm) : undefined; await new Promise(resolve => setTimeout(resolve, 100)); await prefetch; expect(await read(pm)).toBe(1000n); return Date.now() - start; })();
    await vi.advanceTimersByTimeAsync(overlap ? 100 : 200); return work;
  };
  const before = await run(false), after = await run(true); expect(before).toBe(200); expect(after).toBe(100);
  console.info("LOCAL_DEPOSIT_BENCHMARK " + JSON.stringify({ beforeMs: before, afterMs: after, gainMs: before - after, basis: "mocked 100ms admission/RPC, real TTL getter, no chain operations" }));
});
it("preserves freshness recheck and late nonce allocation in actual relay wiring", () => {
  const source = readFileSync(new URL("../lib/server/fastRelay.ts", import.meta.url), "utf8");
  const send = source.slice(source.indexOf("export async function sendUserOperationSync"));
  expect(send.indexOf("requireSelfBundlerMode()")).toBeLessThan(send.indexOf("const deposit"));
  expect(send).toContain("await deposit;"); expect(send).toContain('"paymasterDeposit", () => paymasterDepositCached(pm)');
  // indexOf(-1) must not pass vacuously: every anchor has to exist.
  const at = (needle: string) => { const i = send.indexOf(needle); expect(i, needle).toBeGreaterThan(0); return i; };
  expect(at("authorizeRelayOperation(op")).toBeLessThan(at("r = await sendWithCursor"));
  expect(at("await Promise.all([budgetP, fresh]);")).toBeLessThan(at("r = await sendWithCursor"));
  expect(at("recheckUnderLease(op, metrics)")).toBeGreaterThan(at("async function freshReadsOp"));
  // AUDIT M1: the deposit guard always runs under the lease (underLeaseOp), alongside the expiry margin (M2).
  expect(at("requireExpiryMargin(f); await depositGuard(op, v.fee, metrics);")).toBeGreaterThan(at("async function underLeaseOp"));
  expect(send).toContain('"nonceAllocate"'); expect(send).toContain('"l1ResidualWait"');
});

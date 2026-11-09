/**
 * Speedup 1 (lee, Nov 7 11:02 AM CT): exact simulation runs concurrently with admission, BEFORE the sender lease;
 * the state it relied on is re-checked UNDER the lease before any relayer nonce, signature or send.
 * Real fastRelay + relayLockdown wiring; every RPC/KV/send is mocked. No chain operations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, pad, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  return {
    chain: vi.fn(), block: vi.fn(), read: vi.fn(), call: vi.fn(), code: vi.fn(), slot: vi.fn(), txCount: vi.fn(), balance: vi.fn(),
    session: vi.fn(), curveOf: vi.fn(), curveInfo: vi.fn(),
    mget: vi.fn(), gen: vi.fn(), set: vi.fn(), del: vi.fn(), incr: vi.fn(),
    deposit: vi.fn(), send: vi.fn(), events: [] as string[],
  };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({
  getChainId: h.chain, getBlock: h.block, readContract: h.read, call: h.call, getCode: h.code, getStorageAt: h.slot,
  getTransactionCount: h.txCount, getBalance: h.balance,
}) }));
vi.mock("@disciple/session-keys", async original => ({ ...await original<typeof import("@disciple/session-keys")>(), readSession: h.session }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({ mget: h.mget, nonceAlloc: h.gen, setNX: h.set, delIfEq: h.del, incrEx: h.incr, ttl: async () => -2 }) }));
vi.mock("../lib/server/gradBuy", async original => ({ ...await original<typeof import("../lib/server/gradBuy")>(), chainGradReads: () => ({ router: "0x688160633b22012717661545df6299d3d3174ad2", usdg: "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d", curveOf: h.curveOf, curveInfo: h.curveInfo }) }));
vi.mock("../lib/server/paymasterDeposit", () => ({ allowedPaymaster: () => "0x5C3f7400ED41aCd7409D213caB2909e3b1E31136", paymasterDepositCached: h.deposit, debitPaymasterDeposit: vi.fn() }));
vi.mock("../lib/server/relayer", () => ({ relayerKey: () => KEY, relayerIsFaucet: () => false }));
vi.mock("../lib/server/relayTrustStore", () => ({ kvTrustStore: () => ({ load: async () => null, save: async () => undefined, claimFirstPrime: async () => false }) }));
vi.mock("../lib/server/syncSend", async original => ({ ...await original<typeof import("../lib/server/syncSend")>(), syncSend: h.send, jsonRpc: () => async () => null }));
const KEY = generatePrivateKey();
process.env.RELAYER_NONCE_SHARED = "0";
import { sendUserOperationSync } from "../lib/server/fastRelay";
import { ACCOUNT_PROXY_RUNTIME } from "../lib/server/relayAuth";
import { RelayMetrics } from "../lib/server/relayMetrics";
import type { UserOp } from "../lib/aa/core";

const sender = "0x0000000000000000000000000000000000000011" as Address;
const pm = "0x5C3f7400ED41aCd7409D213caB2909e3b1E31136" as Address;
const impl = "0x00000000000000000000000000000000000000aa" as Address;
const token = "0x0000000000000000000000000000000000000022" as Address;
const router = "0x688160633b22012717661545df6299d3d3174ad2" as Address;
const usdg = "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d" as Address;
const exec = parseAbi(["function executeBatch((address target,uint256 value,bytes data)[])"]);
const erc20 = parseAbi(["function approve(address,uint256)"]);
const buy = parseAbi(["function buyWithUsdg(address,uint256,uint256,uint256)"]);
const NONCE = ((7n << 8n) << 64n) | 3n;   // session entity 7, sequence 3
const op = (): UserOp => ({
  sender, nonce: `0x${NONCE.toString(16)}`, signature: "0x1234",
  callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [[
    { target: usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [router, 10n] }) },
    { target: router, value: 0n, data: encodeFunctionData({ abi: buy, functionName: "buyWithUsdg", args: [token, 10n, 1n, 150n] }) }]] }),
  callGasLimit: "0x100000", verificationGasLimit: "0x40000", preVerificationGas: "0x10000",
  maxFeePerGas: "0x2000000", maxPriorityFeePerGas: "0xf4240",
  paymaster: pm, paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x30000", paymasterData: "0x",
} as unknown as UserOp);
const receipt = { transactionHash: `0x${"ab".repeat(32)}` as Hex, blockHash: `0x${"cd".repeat(32)}` as Hex, blockNumber: "0x1", status: "0x1", gasUsed: "0x1", logs: [] };
let chainNonce = NONCE, sessionState = { active: true, validUntil: 1000 }, depositWei = 10n ** 18n, verifiedUntil = 1000n;
const SIM_REVERT = "AA25 invalid account nonce";
beforeEach(() => {
  vi.clearAllMocks(); h.events.length = 0;
  process.env.GAS_SPONSORSHIP_MODE = "self"; process.env.NEXT_PUBLIC_SESSION_POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2";
  delete process.env.VERCEL_ENV; delete process.env.VERCEL;
  chainNonce = NONCE; sessionState = { active: true, validUntil: 1000 }; depositWei = 10n ** 18n; verifiedUntil = 1000n;
  h.chain.mockResolvedValue(46630); h.block.mockResolvedValue({ timestamp: 100n, baseFeePerGas: 1n });
  h.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getNonce") { h.events.push("recheck:nonce"); return chainNonce; }
    if (functionName === "verifiedUntil") return verifiedUntil;
    if (functionName === "moduleId") return "disciple.session-policy.1.4.3";
    if (functionName === "SEMI_MODULAR_ACCOUNT_IMPL" || functionName === "ACCOUNT_IMPLEMENTATION") return impl;
    return pm;
  });
  // Exact simulation: EntryPoint validation fails (AA25) once the chain nonce for this key moved.
  h.call.mockImplementation(async ({ to }: { to: string }) => {
    if (to.toLowerCase() === "0x00000000000000000000000000000000000000c8") throw new Error("no node interface");
    h.events.push(`simulate:${h.set.mock.calls.length ? "underLease" : "beforeLease"}`);
    if (chainNonce !== NONCE) throw new Error(SIM_REVERT);
    return { data: "0x" };
  });
  h.code.mockResolvedValue(`${ACCOUNT_PROXY_RUNTIME}${sender.slice(2)}`); h.slot.mockResolvedValue(pad(impl, { size: 32 }));
  h.txCount.mockResolvedValue(5); h.balance.mockResolvedValue(0n);
  h.session.mockImplementation(async () => sessionState);
  h.curveOf.mockResolvedValue("0x0000000000000000000000000000000000000033"); h.curveInfo.mockResolvedValue({ token, quote: usdg, graduated: false });
  h.mget.mockResolvedValue(["4", null]);            // generation 4, no lease holder
  h.gen.mockResolvedValue(4);                       // nobody else held the lease in between
  h.set.mockImplementation(async () => { h.events.push("lease"); return true; }); h.del.mockResolvedValue(true); h.incr.mockResolvedValue(1);
  h.deposit.mockImplementation(async () => depositWei);
  h.send.mockImplementation(async () => { h.events.push("send"); return { rc: receipt, via: "sync", sendMs: 1, minedMs: 0, pending: false }; });
});
const noSend = () => { expect(h.send).not.toHaveBeenCalled(); expect(h.events).not.toContain("send"); };

describe("speedup 1: simulate before the lease, re-check under the lease", () => {
  it("fresh speculation: simulation before the lease, nonce re-check under it, then exactly one send", async () => {
    const m = new RelayMetrics();
    const r = await sendUserOperationSync(op(), undefined, undefined, m);
    expect(r.kind).toBe("confirmed");
    expect(h.events.filter(e => e.startsWith("simulate"))).toEqual(["simulate:beforeLease"]);
    expect(h.events.indexOf("simulate:beforeLease")).toBeLessThan(h.events.indexOf("lease"));
    expect(h.events.indexOf("lease")).toBeLessThan(h.events.indexOf("recheck:nonce"));
    expect(h.events.indexOf("recheck:nonce")).toBeLessThan(h.events.indexOf("send"));
    expect(h.send).toHaveBeenCalledOnce();
    const snap = m.snapshot();
    expect(snap.speculationStale).toBe(0); expect(snap.resimulateUnderLease).toBe(0);
    for (const k of ["freshnessSnapshot", "speculativePreflight", "admissionSimulationWall", "leaseGeneration", "leaseRecheck", "leaseRecheckReads", "admissionWall", "leaseAcquire", "simulate"]) expect(k in snap).toBe(true);
  });
  it("stale-simulation race: another same-sender op held the lease in between ⇒ re-simulated under the lease; its nonce moved ⇒ notSent, nothing signed or sent", async () => {
    h.gen.mockImplementation(async () => { chainNonce = NONCE + 1n; return 5; });   // the other op landed (same key) and bumped the generation
    const m = new RelayMetrics();
    await expect(sendUserOperationSync(op(), undefined, undefined, m)).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("AA25") });
    expect(h.events.filter(e => e.startsWith("simulate"))).toEqual(["simulate:beforeLease", "simulate:underLease"]);
    expect(m.snapshot().speculationStale).toBe(1); expect(h.incr).not.toHaveBeenCalled(); noSend();
    expect(h.del).toHaveBeenCalledOnce();   // definite pre-send rejection releases the lease
  });
  it("stale race where the other op used a different key: re-simulation passes ⇒ one send, still after the under-lease simulation", async () => {
    h.gen.mockResolvedValue(5);
    await expect(sendUserOperationSync(op())).resolves.toMatchObject({ kind: "confirmed" });
    expect(h.events.filter(e => e.startsWith("simulate"))).toEqual(["simulate:beforeLease", "simulate:underLease"]);
    expect(h.events.indexOf("simulate:underLease")).toBeLessThan(h.events.indexOf("send"));
  });
  it("a lease held at snapshot time never trusts the speculation", async () => {
    h.mget.mockResolvedValue(["4", "other-tag"]);
    await sendUserOperationSync(op());
    expect(h.events.filter(e => e.startsWith("simulate"))).toEqual(["simulate:beforeLease", "simulate:underLease"]);
  });
  it("same-key nonce changes between simulation and lease (generation unchanged) ⇒ under-lease nonce re-check: notSent, retryable, nothing sent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); chainNonce = NONCE + 1n; return true; });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, retryable: true, message: expect.stringContaining("nonce changed") });
    noSend(); expect(h.del).toHaveBeenCalledOnce();
  });
  it("session revoked between simulation and lease ⇒ notSent, nothing signed or sent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); sessionState = { active: false, validUntil: 1000 }; return true; });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("inactive") });
    noSend();
  });
  it("LoginGate cleared between simulation and lease ⇒ notSent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); verifiedUntil = 0n; return true; });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("unauthenticated") });
    noSend();
  });
  it("paymaster deposit drained between simulation and lease ⇒ deposit guard rejects under the lease: notSent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); depositWei = 0n; return true; });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true });
    noSend();
  });
  it("account implementation changed between simulation and lease ⇒ notSent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); h.slot.mockResolvedValue(pad(router, { size: 32 })); return true; });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("implementation") });
    noSend();
  });
  for (const gate of ["login", "session", "target"] as const) it(`admission (${gate}) fails after a successful simulation ⇒ notSent, no lease, budget, sign or send`, async () => {
    if (gate === "login") verifiedUntil = 0n;
    if (gate === "session") sessionState = { active: false, validUntil: 1000 };
    if (gate === "target") h.curveInfo.mockResolvedValue({ token: sender, quote: usdg, graduated: false });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true });
    expect(h.events).toContain("simulate:beforeLease");
    expect(h.set).not.toHaveBeenCalled(); expect(h.incr).not.toHaveBeenCalled(); expect(h.gen).not.toHaveBeenCalled(); noSend();
  });
  it("speculative simulation failure ⇒ notSent before any lease", async () => {
    chainNonce = NONCE + 1n;
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("AA25") });
    expect(h.set).not.toHaveBeenCalled(); noSend();
  });
  it("malformed / owner-nonce ops never reach speculative simulation", async () => {
    await expect(sendUserOperationSync({ ...op(), nonce: "0x1" })).rejects.toMatchObject({ notSent: true });
    expect(h.call).not.toHaveBeenCalled(); expect(h.mget).not.toHaveBeenCalled();
  });
  it("unreadable fence snapshot fails safe: full re-validation under the lease", async () => {
    h.mget.mockRejectedValue(new Error("store offline"));
    await sendUserOperationSync(op());
    expect(h.events.filter(e => e.startsWith("simulate"))).toEqual(["simulate:beforeLease", "simulate:underLease"]);
  });
});

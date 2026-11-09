/**
 * Speedup 1 (lee, Nov 7 11:02 AM CT): exact simulation runs concurrently with admission, BEFORE the sender lease;
 * the state it relied on is re-checked UNDER the lease before any relayer nonce, signature or send.
 * Real fastRelay + relayLockdown wiring; every RPC/KV/send is mocked. No chain operations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, pad, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  return {
    chain: vi.fn(), block: vi.fn(), read: vi.fn(), call: vi.fn(), code: vi.fn(), slot: vi.fn(), txCount: vi.fn(), balance: vi.fn(),
    session: vi.fn(), curveOf: vi.fn(), curveInfo: vi.fn(),
    mget: vi.fn(), gate: vi.fn(), gen: vi.fn(), set: vi.fn(), del: vi.fn(), incr: vi.fn(), refund: vi.fn(),
    deposit: vi.fn(), send: vi.fn(), events: [] as string[],
  };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({
  getChainId: h.chain, getBlock: h.block, readContract: h.read, call: h.call, getCode: h.code, getStorageAt: h.slot,
  getTransactionCount: h.txCount, getBalance: h.balance,
}) }));
vi.mock("@disciple/session-keys", async original => ({ ...await original<typeof import("@disciple/session-keys")>(), readSession: h.session }));
// Fence snapshot MGET [leasegen, pending] → h.mget; revoke-marker / strike-ledger MGETs → h.gate.
vi.mock("../lib/server/kv", () => ({ kv: () => ({ mget: (ks: string[]) => ks[0].startsWith("relay:leasegen:") ? h.mget(ks) : h.gate(ks), nonceAlloc: h.gen, setNX: h.set, delIfEq: h.del, incrEx: h.incr, ttl: async () => -2,
  // finding 1: the atomic budget call; h.incr still records "the paid budget was charged"
  relayBudget: async (...a: unknown[]) => { await h.incr(...a); return 0; }, decrIfPositive: async (k: string) => { await h.refund(k); return 0; } }) }));
vi.mock("../lib/server/gradBuy", async original => ({ ...await original<typeof import("../lib/server/gradBuy")>(), chainGradReads: () => ({ router: "0x688160633b22012717661545df6299d3d3174ad2", usdg: "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d", curveOf: h.curveOf, curveInfo: h.curveInfo }) }));
vi.mock("../lib/server/paymasterDeposit", () => ({ allowedPaymaster: () => "0x5C3f7400ED41aCd7409D213caB2909e3b1E31136", paymasterDepositCached: h.deposit, debitPaymasterDeposit: vi.fn() }));
vi.mock("../lib/server/relayer", () => ({ relayerKey: () => KEY, relayerIsFaucet: () => false }));
vi.mock("../lib/server/relayTrustStore", () => ({ kvTrustStore: () => ({ load: async () => null, save: async () => undefined, claimFirstPrime: async () => false }) }));
vi.mock("../lib/server/syncSend", async original => ({ ...await original<typeof import("../lib/server/syncSend")>(), syncSend: h.send, jsonRpc: () => async () => null }));
const KEY = generatePrivateKey();
process.env.RELAYER_NONCE_SHARED = "0";
import { sendUserOperationSync } from "../lib/server/fastRelay";
import { admissionImmutableCache, EXPIRY_MARGIN_SEC, PRE_LEASE_MAX_AGE_MS, requireExpiryMargin, strikeSource } from "../lib/server/relayLockdown";
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
let marker: string | null = null, trust: string | null = null, skew = 0;
// Local clock offset for the M3 age-cap tests (never touches the mocked chain timestamp).
const realNow = Date.now.bind(Date);
vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
afterEach(() => { skew = 0; });
beforeEach(() => {
  vi.clearAllMocks(); h.events.length = 0; admissionImmutableCache.clear();
  process.env.GAS_SPONSORSHIP_MODE = "self"; process.env.NEXT_PUBLIC_SESSION_POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2";
  delete process.env.VERCEL_ENV; delete process.env.VERCEL;
  chainNonce = NONCE; sessionState = { active: true, validUntil: 1000 }; depositWei = 10n ** 18n; verifiedUntil = 1000n;
  h.chain.mockResolvedValue(46630); h.block.mockResolvedValue({ timestamp: 100n, baseFeePerGas: 1n });
  h.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getNonce") { h.events.push(`recheck:nonce:${h.set.mock.calls.length ? "underLease" : "beforeLease"}`); return chainNonce; }
    if (functionName === "verifiedUntil") { h.events.push(`login:${h.set.mock.calls.length ? "underLease" : "beforeLease"}`); return verifiedUntil; }
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
  marker = null; trust = null; skew = 0; strikeSource.local = () => 0;
  h.gate.mockImplementation(async (ks: string[]) => { h.events.push(`gate:${h.set.mock.calls.length ? "underLease" : "beforeLease"}`); return ks.map(k => k.startsWith("relay:revoked:") ? marker : trust); });
  h.gen.mockResolvedValue(4);                       // nobody else held the lease in between
  h.set.mockImplementation(async () => { h.events.push("lease"); return true; }); h.del.mockResolvedValue(true); h.incr.mockResolvedValue(1);
  h.deposit.mockImplementation(async () => { h.events.push(`deposit:${h.set.mock.calls.length ? "underLease" : "beforeLease"}`); return depositWei; });
  h.send.mockImplementation(async () => { h.events.push("send"); return { rc: receipt, via: "sync", sendMs: 1, minedMs: 0, pending: false }; });
});
const noSend = () => { expect(h.send).not.toHaveBeenCalled(); expect(h.events).not.toContain("send"); };

describe("speedup 1: simulate before the lease, re-check under the lease", () => {
  it("fresh speculation (speedup (a)): simulation + fresh reads before the lease; under it only fence, marker, deposit guard, expiry margin; then exactly one send", async () => {
    const m = new RelayMetrics();
    const r = await sendUserOperationSync(op(), undefined, undefined, m);
    expect(r.kind).toBe("confirmed");
    expect(h.events.filter(e => e.startsWith("simulate"))).toEqual(["simulate:beforeLease"]);
    expect(h.events.indexOf("simulate:beforeLease")).toBeLessThan(h.events.indexOf("lease"));
    // lee 12:21 CT Nov 9 (full (a)): the nonce / LoginGate re-read moved before the lease; no RPC freshness read under it.
    expect(h.events).toContain("recheck:nonce:beforeLease");
    expect(h.events.filter(e => e.endsWith(":underLease") && !e.startsWith("simulate"))).toEqual(expect.arrayContaining(["gate:underLease", "deposit:underLease"]));
    expect(h.events).not.toContain("recheck:nonce:underLease"); expect(h.events).not.toContain("login:underLease");
    expect(h.events.indexOf("deposit:underLease")).toBeLessThan(h.events.indexOf("send"));
    expect(h.events.indexOf("gate:underLease")).toBeLessThan(h.events.indexOf("send"));
    expect(h.send).toHaveBeenCalledOnce();
    const snap = m.snapshot();
    expect(snap.speculationStale).toBe(0); expect(snap.resimulateUnderLease).toBe(0);
    for (const k of ["freshnessSnapshot", "speculativePreflight", "preLeaseRecheck", "admissionSimulationWall", "leaseGeneration", "leaseRecheck", "leaseRecheckReads", "admissionWall", "leaseAcquire", "simulate", "revokeStrikeGate"]) expect(k in snap).toBe(true);
    expect(snap.preLeaseAgeCap).toBe(0);
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
  // Reworked per lee 12:21 CT Nov 9 (was :123 same-key nonce change ⇒ under-lease re-read): now the M3 age-cap path.
  it("age cap (M3): pre-lease reads older than the cap ⇒ fresh read wave again under the lease; nonce moved ⇒ notSent, retryable, nothing sent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); chainNonce = NONCE + 1n; skew = PRE_LEASE_MAX_AGE_MS + 50; return true; });
    const m = new RelayMetrics();
    await expect(sendUserOperationSync(op(), undefined, undefined, m)).rejects.toMatchObject({ notSent: true, retryable: true, message: expect.stringContaining("nonce changed") });
    expect(m.snapshot().preLeaseAgeCap).toBe(1); expect(h.events).toContain("recheck:nonce:underLease");
    noSend(); expect(h.del).toHaveBeenCalledOnce();
  });
  // Reworked per lee 12:21 CT Nov 9 (was :128 session revoked ⇒ under-lease re-read): now the M4 revoke-marker path.
  it("revoke marker (M4) written after admission ⇒ read with the fence under the lease ⇒ notSent, no budget, nothing signed or sent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); marker = String(Date.now()); sessionState = { active: false, validUntil: 1000 }; return true; });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("revoked") });
    expect(h.events).toContain("gate:underLease"); expect(h.incr).not.toHaveBeenCalled(); noSend(); expect(h.del).toHaveBeenCalledOnce();
  });
  // Reworked per lee 12:21 CT Nov 9 (was :133 LoginGate cleared ⇒ under-lease re-read): now the M3 age-cap path.
  it("age cap (M3): LoginGate cleared and pre-lease reads past the cap ⇒ under-lease LoginGate re-read ⇒ notSent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); verifiedUntil = 0n; skew = PRE_LEASE_MAX_AGE_MS + 1; return true; });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("unauthenticated") });
    expect(h.events).toContain("login:underLease"); noSend();
  });
  // Reworked per lee 12:21 CT Nov 9 (was :143 implementation changed ⇒ under-lease re-read): now the stale-fence path.
  it("stale fence: implementation changed and the generation moved ⇒ full stale path (re-admission + re-validation) ⇒ notSent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); h.slot.mockResolvedValue(pad(router, { size: 32 })); return true; });
    h.gen.mockResolvedValue(5);
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("implementation") });
    expect(h.events).toContain("login:underLease");   // re-admission ran under the lease even though nothing queued
    noSend();
  });
  it("ACCEPTED WINDOW (lee 12:21 CT Nov 9): an external revoke after the pre-lease read, fence unchanged, inside the age cap and without a marker, is NOT caught off-chain (on-chain validation decides)", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); sessionState = { active: false, validUntil: 1000 }; return true; });
    await expect(sendUserOperationSync(op())).resolves.toMatchObject({ kind: "confirmed" });
    expect(h.send).toHaveBeenCalledOnce();
  });
  it("unreadable revoke marker under the lease ⇒ stale path: full re-admission (marker re-read, fail closed) + re-simulation", async () => {
    let n = 0;
    h.gate.mockImplementation(async (ks: string[]) => { if (h.set.mock.calls.length && n++ === 0) throw new Error("store blip"); return ks.map(() => null); });
    const m = new RelayMetrics();
    await expect(sendUserOperationSync(op(), undefined, undefined, m)).resolves.toMatchObject({ kind: "confirmed" });
    expect(m.snapshot().speculationStale).toBe(1);
    expect(h.events.filter(e => e.startsWith("simulate"))).toEqual(["simulate:beforeLease", "simulate:underLease"]);
    h.gate.mockRejectedValue(new Error("store offline")); vi.clearAllMocks(); h.events.length = 0;
    h.gate.mockRejectedValue(new Error("store offline"));
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true }); noSend();
  });
  it("revoke marker present at admission ⇒ notSent before any lease", async () => {
    marker = "1";
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("revoked") });
    expect(h.set).not.toHaveBeenCalled(); noSend();
  });
  it("strike window (hardening 6): local ledger, KV ledger, corrupt ledger and unreadable store all refuse before any lease; an expired strike passes", async () => {
    strikeSource.local = () => Date.now() + 60_000;
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike") });
    strikeSource.local = () => 0; trust = JSON.stringify({ strikeUntil: Date.now() + 60_000 });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike") });
    trust = "{not json";
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike") });
    trust = null; h.gate.mockRejectedValueOnce(new Error("store offline"));
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("store unavailable") });
    expect(h.set).not.toHaveBeenCalled(); noSend();
    trust = JSON.stringify({ strikeUntil: Date.now() - 1 });
    await expect(sendUserOperationSync(op())).resolves.toMatchObject({ kind: "confirmed" });
  });
  it("expiry margin (M2): a session expiring within the margin is refused before the lease", async () => {
    sessionState = { active: true, validUntil: 100 + EXPIRY_MARGIN_SEC };   // block timestamp 100
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("expiry margin") });
    expect(h.set).not.toHaveBeenCalled(); noSend();
  });
  it("expiry margin (M2) is chain-time based and advances with local elapsed time since the read", () => {
    const f = { blockTs: 100, verifiedUntil: 110, validUntil: 110, readAtMs: 1_000 };
    expect(() => requireExpiryMargin(f, 1_000)).not.toThrow();
    expect(() => requireExpiryMargin(f, 1_000 + 6_500)).toThrow(/expiry margin/);   // 100 + 7 + 3 ≥ 110
    expect(() => requireExpiryMargin({ ...f, verifiedUntil: 103 }, 1_000)).toThrow(/LoginGate/);
  });
  it("fence nonceAlloc failure under the lease ⇒ notSent (AUDIT Info), lease released, no budget, nothing signed or sent", async () => {
    h.gen.mockRejectedValue(new Error("store offline"));
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: "store offline" });
    expect(h.incr).not.toHaveBeenCalled(); noSend(); expect(h.del).toHaveBeenCalledOnce();
  });
  it("pre-lease fresh read failure (implementation changed before the lease) ⇒ notSent before any lease", async () => {
    h.slot.mockResolvedValue(pad(router, { size: 32 }));
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("implementation") });
    expect(h.set).not.toHaveBeenCalled(); noSend();
  });
  it("paymaster deposit drained between simulation and lease ⇒ deposit guard rejects under the lease: notSent", async () => {
    h.set.mockImplementation(async () => { h.events.push("lease"); depositWei = 0n; return true; });
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true });
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

describe("Vercel Security findings on the self-relay path", () => {
  it("finding 1: a rejection after the budget but before signing refunds the global unit; a send keeps it", async () => {
    await expect(sendUserOperationSync(op(), undefined, async () => { throw new Error("press limit"); })).rejects.toMatchObject({ notSent: true, message: "press limit" });
    expect(h.incr).toHaveBeenCalledOnce(); expect(h.refund).toHaveBeenCalledExactlyOnceWith("relay:paid:global"); noSend();
    h.incr.mockClear(); h.refund.mockClear();
    await expect(sendUserOperationSync(op())).resolves.toMatchObject({ kind: "confirmed" });
    expect(h.incr).toHaveBeenCalledOnce(); expect(h.refund).not.toHaveBeenCalled(); expect(h.send).toHaveBeenCalledOnce();
  });
  it("finding 1: an over-cap (rate-limited) attempt charges nothing to refund and sends nothing", async () => {
    h.incr.mockRejectedValue(new Error("relay rate limited"));
    await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: "relay rate limited" });
    expect(h.refund).not.toHaveBeenCalled(); noSend();
  });
  it("finding 2: a custom-code or foreign-implementation sender is rejected before any budget, lease or send", async () => {
    for (const arrange of [() => h.code.mockResolvedValue("0x6080604052348015600f57600080fd5b50"), () => h.code.mockResolvedValue(ACCOUNT_PROXY_RUNTIME),
      () => h.slot.mockResolvedValue(pad("0x00000000000000000000000000000000000000bb", { size: 32 }))]) {
      h.code.mockResolvedValue(`${ACCOUNT_PROXY_RUNTIME}${sender.slice(2)}`); h.slot.mockResolvedValue(pad(impl, { size: 32 })); arrange();
      await expect(sendUserOperationSync(op())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("relay authorization") });
      expect(h.incr).not.toHaveBeenCalled(); noSend();
    }
  });
});

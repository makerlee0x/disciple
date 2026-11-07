import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi, pad, type Address } from "viem";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  return { chain: vi.fn(), block: vi.fn(), read: vi.fn(), session: vi.fn(), curveOf: vi.fn(), curveInfo: vi.fn(), incr: vi.fn(), set: vi.fn(), del: vi.fn() };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ getChainId: h.chain, getBlock: h.block, readContract: h.read }) }));
vi.mock("@disciple/session-keys", async original => ({ ...await original<typeof import("@disciple/session-keys")>(), readSession: h.session }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({ incrEx: h.incr, setNX: h.set, delIfEq: h.del }) }));
vi.mock("../lib/server/gradBuy", () => ({ chainGradReads: () => ({ router: "0x688160633b22012717661545df6299d3d3174ad2", usdg: "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d", curveOf: h.curveOf, curveInfo: h.curveInfo }) }));
import { admissionImmutableCache, admitRelay, lockedRelay, relaySendBudget, requireLogin, sessionEntity } from "../lib/server/relayLockdown";
import { ACCOUNT_PROXY_RUNTIME, authorizeRelayOperation, type RelayAuthReads } from "../lib/server/relayAuth";
import type { UserOp } from "../lib/aa/core";
import { checkSponsoredCalls } from "../lib/server/gasSponsorship";
import { chainGradReads } from "../lib/server/gradBuy";
import { RelayMetrics } from "../lib/server/relayMetrics";
import { SenderTrust } from "../lib/server/relayTrust";
const sender = "0x0000000000000000000000000000000000000011" as Address;
const pm = "0x5C3f7400ED41aCd7409D213caB2909e3b1E31136";
const token = "0x0000000000000000000000000000000000000022" as Address;
const router = "0x688160633b22012717661545df6299d3d3174ad2" as Address;
const usdg = "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d" as Address;
const exec = parseAbi(["function executeBatch((address target,uint256 value,bytes data)[])"]);
const erc20 = parseAbi(["function approve(address,uint256)", "function transfer(address,uint256)"]);
const buy = parseAbi(["function buyWithUsdg(address,uint256,uint256,uint256)"]);
const calls = () => [{ target: usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [router, 10n] }) }, { target: router, value: 0n, data: encodeFunctionData({ abi: buy, functionName: "buyWithUsdg", args: [token, 10n, 1n, 150n] }) }];
const op = (): UserOp => ({ sender, nonce: `0x${((7n << 8n) << 64n).toString(16)}`, signature: "0x1234", callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [calls()] }) });
beforeEach(() => {
  vi.resetAllMocks(); admissionImmutableCache.clear(); process.env.GAS_SPONSORSHIP_MODE = "self"; process.env.NEXT_PUBLIC_SESSION_POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2";
  delete process.env.VERCEL_ENV; delete process.env.VERCEL;
  h.chain.mockResolvedValue(46630); h.block.mockResolvedValue({ timestamp: 100n });
  h.read.mockImplementation(async ({ functionName }) => functionName === "verifiedUntil" ? 1000n : functionName === "moduleId" ? "disciple.session-policy.1.4.3" : pm);
  h.curveOf.mockResolvedValue("0x0000000000000000000000000000000000000033"); h.curveInfo.mockResolvedValue({ token, quote: usdg, graduated: false });
  h.session.mockResolvedValue({ active: true, validUntil: 1000 }); h.incr.mockResolvedValue(1); h.set.mockResolvedValue(true); h.del.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
describe("restored relay admission", () => {
  it("allows Preview's production Node runtime without relaxing admission", async () => {
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("VERCEL", "1"); vi.stubEnv("NODE_ENV", "production");
    await expect(admitRelay(op())).resolves.toBeUndefined();
    h.read.mockResolvedValue(0n); await expect(admitRelay(op())).rejects.toThrow("unauthenticated");
  });
  it("allows explicitly local vercel dev while keeping deployed Production off", async () => {
    vi.stubEnv("VERCEL_ENV", "development"); vi.stubEnv("VERCEL", "1"); vi.stubEnv("NODE_ENV", "development");
    await expect(admitRelay(op())).resolves.toBeUndefined();
  });
  it("rejects Production even with the legacy self switch enabled", async () => {
    vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("VERCEL", "1"); vi.stubEnv("AA_SELF_BUNDLER", "1");
    await expect(admitRelay(op())).rejects.toThrow("disabled");
  });
  it("admits only canonical authenticated session trades, not owner nonces", async () => {
    await expect(admitRelay(op())).resolves.toBeUndefined();
    expect(() => sessionEntity({ ...op(), nonce: "0x1" })).toThrow();
    expect(() => sessionEntity({ ...op(), nonce: `0x${(((7n << 8n) | 1n) << 64n).toString(16)}` })).toThrow();
  });
  it("unauthenticated op never reaches simulation or broadcast", async () => {
    h.read.mockResolvedValue(0n); const send = vi.fn(); await expect(lockedRelay(op(), send)).rejects.toThrow("unauthenticated"); expect(send).not.toHaveBeenCalled();
  });
  it("rejects nonallowlisted target/withdrawal, including a known ERC20 selector", async () => {
    const bad = { ...op(), callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [[{ target: usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sender, 1n] }) }]] }) };
    const send = vi.fn(); await expect(lockedRelay(bad, send)).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
  });
  it("rejects an unpaired approval and an unknown target carrying a trade selector", async () => {
    const cs = calls(); cs[1].target = "0x0000000000000000000000000000000000000044" as Address;
    await expect(admitRelay({ ...op(), callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [cs] }) })).rejects.toThrow();
    await expect(admitRelay({ ...op(), callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [[calls()[0]]] }) })).rejects.toThrow();
  });
  it("does not cache current curve metadata or broaden the registered target", async () => {
    await admitRelay(op()); h.curveInfo.mockResolvedValue({ token: sender, quote: usdg, graduated: false });
    await expect(admitRelay(op())).rejects.toThrow(); expect(h.curveInfo).toHaveBeenCalledTimes(2);
  });
  it("rejects expired and revoked sessions", async () => {
    h.session.mockResolvedValue({ active: false, validUntil: 1000 }); await expect(admitRelay(op())).rejects.toThrow("inactive");
    h.session.mockResolvedValue({ active: true, validUntil: 99 }); await expect(admitRelay(op())).rejects.toThrow("expired");
  });
  it("disabled / production / wrong-chain modes fail closed", async () => {
    process.env.GAS_SPONSORSHIP_MODE = "bso"; await expect(admitRelay(op())).rejects.toThrow("disabled");
    process.env.GAS_SPONSORSHIP_MODE = "self"; process.env.VERCEL_ENV = "production"; await expect(admitRelay(op())).rejects.toThrow("disabled");
    delete process.env.VERCEL_ENV; h.chain.mockResolvedValue(4663); await expect(admitRelay(op())).rejects.toThrow("unauthenticated");
  });
  it("shared limits fail closed on exhaustion and store failure", async () => {
    h.incr.mockResolvedValue(61); await expect(relaySendBudget(sender)).rejects.toThrow("rate limited");
    h.incr.mockRejectedValue(new Error("store offline")); await expect(relaySendBudget(sender)).rejects.toThrow("store offline");
  });
  it("queues a rapid tap without submitting while another sender lease is held", async () => {
    vi.useFakeTimers();
    try {
      h.set.mockResolvedValueOnce(false); const send = vi.fn().mockResolvedValue("receipt"); const p = lockedRelay(op(), send);
      await vi.advanceTimersByTimeAsync(1); expect(send).not.toHaveBeenCalled();
      await vi.runAllTimersAsync(); await expect(p).resolves.toBe("receipt"); expect(send).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("revalidates a queued session before simulation or signing", async () => {
    vi.useFakeTimers();
    try {
      h.set.mockResolvedValueOnce(false); const send = vi.fn(); const p = lockedRelay(op(), send); const rejected = expect(p).rejects.toThrow("expired");
      await vi.advanceTimersByTimeAsync(1); h.session.mockResolvedValue({ active: false, validUntil: 99 });
      await vi.runAllTimersAsync(); await rejected; expect(send).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("emits a known receipt before release, but keeps the lease until compare-and-delete completes", async () => {
    let release!: () => void;
    h.del.mockImplementation(() => new Promise<void>(r => { release = r; }));
    const confirmed = vi.fn(), p = lockedRelay(op(), async () => "receipt", undefined, confirmed);
    await vi.waitFor(() => expect(h.del).toHaveBeenCalledOnce());
    expect(confirmed).toHaveBeenCalledWith("receipt");
    let done = false; void p.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    release(); await expect(p).resolves.toBe("receipt");
  });
  it("does not emit a confirmed frame for failed simulation or ambiguous send", async () => {
    const confirmed = vi.fn();
    await expect(lockedRelay(op(), async () => { throw Object.assign(new Error("unclear"), { unclear: true }); }, undefined, confirmed)).rejects.toThrow("unclear");
    expect(confirmed).not.toHaveBeenCalled(); expect(h.del).not.toHaveBeenCalled();
  });
  it("fresh LoginGate/session state still rejects revocation after immutable cache warm", async () => {
    await admitRelay(op());
    h.read.mockImplementation(async ({ functionName }) => functionName === "verifiedUntil" ? 0n : functionName === "moduleId" ? "disciple.session-policy.1.4.3" : pm);
    await expect(admitRelay(op())).rejects.toThrow("unauthenticated");
    h.read.mockImplementation(async ({ functionName }) => functionName === "verifiedUntil" ? 1000n : pm);
    h.session.mockResolvedValue({ active: false, validUntil: 1000 });
    await expect(admitRelay(op())).rejects.toThrow("inactive");
  });
  it("retains quarantine after an ambiguous send; releases definite rejection", async () => {
    await expect(lockedRelay(op(), async () => { throw Object.assign(new Error("unclear"), { unclear: true }); })).rejects.toThrow(); expect(h.del).not.toHaveBeenCalled();
    await expect(lockedRelay(op(), async () => { throw Object.assign(new Error("rejected"), { notSent: true }); })).rejects.toThrow(); expect(h.del).toHaveBeenCalledOnce();
  });
});
function reads(): RelayAuthReads {
  return { getCode: vi.fn().mockResolvedValue(`${ACCOUNT_PROXY_RUNTIME}${sender.slice(2)}`), getStorageAt: vi.fn().mockResolvedValue(pad(sender, { size: 32 })), readContract: vi.fn().mockResolvedValue(sender) };
}
describe("F-02 exact EntryPoint simulation", () => {
  it("Preview still rejects a failed exact simulation before broadcast", async () => {
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("VERCEL", "1"); vi.stubEnv("NODE_ENV", "production");
    const r = reads(), broadcast = vi.fn(), sim = vi.fn().mockRejectedValue(new Error("AA24 invalid signature"));
    await expect(lockedRelay(op(), async () => { await authorizeRelayOperation(op(), r, sim); broadcast(); })).rejects.toThrow("AA24");
    expect(sim).toHaveBeenCalledOnce(); expect(broadcast).not.toHaveBeenCalled();
  });
  it("simulates every identical signed op, even with warm templates", async () => {
    const r = reads(), simulate = vi.fn().mockResolvedValue("0x");
    await authorizeRelayOperation(op(), r, simulate); await authorizeRelayOperation(op(), r, simulate);
    expect(simulate).toHaveBeenCalledTimes(2); expect(r.getCode).toHaveBeenCalledTimes(2); expect(r.getStorageAt).toHaveBeenCalledTimes(2); expect(r.readContract).toHaveBeenCalledOnce();
  });
  it("failing simulation rejects before the EOA broadcast", async () => {
    const r = reads(), broadcast = vi.fn(), sim = vi.fn().mockRejectedValue(new Error("AA24 invalid signature"));
    await expect(lockedRelay(op(), async () => { await authorizeRelayOperation(op(), r, sim); broadcast(); })).rejects.toThrow("AA24"); expect(broadcast).not.toHaveBeenCalled();
  });
  it("rejects runtime/implementation changes despite previous sender success", async () => {
    const r = reads(), sim = vi.fn().mockResolvedValue("0x"); await authorizeRelayOperation(op(), r, sim);
    vi.mocked(r.getStorageAt).mockResolvedValue(pad(router, { size: 32 })); await expect(authorizeRelayOperation(op(), r, sim)).rejects.toThrow("implementation");
    vi.mocked(r.getCode).mockResolvedValue("0x6000"); await expect(authorizeRelayOperation(op(), r, sim)).rejects.toThrow("runtime");
  });
});

describe("sender telemetry never authenticates", () => {
  it("a fresh balance prime remains unverified", () => {
    const trust = new SenderTrust(() => 1000); trust.prime(sender, 100n);
    expect(trust.get(sender)?.verifiedAt).toBe(0); expect(trust.check(sender, 1n)).toBe("unverified");
  });
  it("shared first-prime claims cannot restore the old trust shortcut", async () => {
    const store = { load: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined), claimFirstPrime: vi.fn().mockResolvedValue(true) };
    const trust = new SenderTrust(() => 1000, store); await trust.primeShared(sender, 100n); await trust.flush();
    expect(store.claimFirstPrime).not.toHaveBeenCalled(); expect(trust.check(sender, 1n)).toBe("unverified");
  });
});

// Baseline ordering copied from parent 668ec0e6 admitRelay: LoginGate -> session group -> target's two read waves.
// All reads are mocked. This is a deterministic RTT scheduling benchmark, NOT live throughput or EVM latency.
it("local before/after admission scheduling benchmark, with every mutable check fresh", async () => {
  vi.useFakeTimers();
  try {
    const lag = <T>(value: T) => new Promise<T>(r => setTimeout(() => r(value), 80));
    h.chain.mockImplementation(() => lag(46630)); h.block.mockImplementation(() => lag({ timestamp: 100n }));
    h.read.mockImplementation(({ functionName }) => lag(functionName === "verifiedUntil" ? 1000n : functionName === "moduleId" ? "disciple.session-policy.1.4.3" : pm));
    h.session.mockImplementation(() => lag({ active: true, validUntil: 1000 }));
    h.curveOf.mockImplementation(() => lag("0x0000000000000000000000000000000000000033"));
    h.curveInfo.mockImplementation(() => lag({ token, quote: usdg, graduated: false }));
    const baseline = async () => {
      const now = await requireLogin(sender);
      const [id, paymaster, state] = await Promise.all([h.read({ functionName: "moduleId" }), h.read({ functionName: "paymaster" }), h.session()]);
      if (id !== "disciple.session-policy.1.4.3" || paymaster !== pm || !state.active || state.validUntil <= now) throw new Error("denied");
      await checkSponsoredCalls(op().callData, sender, chainGradReads({} as never, 46630), now);
    };
    const run = async (f: () => Promise<unknown>) => { const start = Date.now(), p = f(); await vi.runAllTimersAsync(); await p; return Date.now() - start; };
    const before = await run(baseline), coldMetrics = new RelayMetrics(Date.now);
    const cold = await run(() => admitRelay(op(), coldMetrics)), coldSnapshot = coldMetrics.snapshot(), warmMetrics = new RelayMetrics(Date.now);
    const warm = await run(() => admitRelay(op(), warmMetrics));
    expect(before).toBe(320); expect(cold).toBe(160); expect(warm).toBe(80);
    expect(h.chain).toHaveBeenCalledTimes(3); expect(h.session).toHaveBeenCalledTimes(3); expect(h.curveInfo).toHaveBeenCalledTimes(3);
    console.info("LOCAL_RELAY_BENCHMARK " + JSON.stringify({ rttModelMs: 80, beforeAdmission: before, afterColdAdmission: cold, afterWarmAdmission: warm, afterCold: coldSnapshot, afterWarm: warmMetrics.snapshot(), basis: "deterministic mocked read RTT; no chain ops" }));
  } finally { vi.useRealTimers(); }
});

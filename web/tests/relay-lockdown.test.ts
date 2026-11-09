import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi, pad, type Address } from "viem";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  return { chain: vi.fn(), block: vi.fn(), read: vi.fn(), session: vi.fn(), curveOf: vi.fn(), curveInfo: vi.fn(), incr: vi.fn(), set: vi.fn(), del: vi.fn(), mget: vi.fn(), budget: vi.fn(), refund: vi.fn() };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ getChainId: h.chain, getBlock: h.block, readContract: h.read }) }));
vi.mock("@disciple/session-keys", async original => ({ ...await original<typeof import("@disciple/session-keys")>(), readSession: h.session }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({ incrEx: h.incr, setNX: h.set, delIfEq: h.del, mget: h.mget, relayBudget: h.budget, decrIfPositive: h.refund }) }));
vi.mock("../lib/server/gradBuy", () => ({ chainGradReads: () => ({ router: "0x688160633b22012717661545df6299d3d3174ad2", usdg: "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d", curveOf: h.curveOf, curveInfo: h.curveInfo }) }));
import { ADMISSION_CACHE_TTL_MS, admissionImmutableCache, admitRelay, lockedRelay, relaySendBudget, requireLogin, sessionEntity } from "../lib/server/relayLockdown";
import { ACCOUNT_PROXY_RUNTIME, authorizeRelayOperation, type RelayAuthReads } from "../lib/server/relayAuth";
import type { UserOp } from "../lib/aa/core";
import { checkSponsoredCalls } from "../lib/server/gasSponsorship";
import { chainGradReads } from "../lib/server/gradBuy";
import { ImmutableRelayCache, RelayMetrics } from "../lib/server/relayMetrics";
import { DEPLOYMENTS } from "../lib/chains";
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
  h.session.mockResolvedValue({ active: true, validUntil: 1000 }); h.incr.mockResolvedValue(1); h.budget.mockResolvedValue(0); h.refund.mockResolvedValue(0); h.set.mockResolvedValue(true); h.del.mockResolvedValue(true); h.mget.mockImplementation(async (ks: string[]) => ks.map(() => null));
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
  // Speedup (c), AUDIT r264 conditions: only immutable token/quote + positive write-once curveOf are cached.
  it("caches only a curve's immutable token/quote (never graduated) and never broadens the registered target", async () => {
    const m = new RelayMetrics();
    await admitRelay(op(), m); await admitRelay(op(), m);
    expect(h.curveInfo).toHaveBeenCalledTimes(1); expect(h.curveOf).toHaveBeenCalledTimes(1);
    expect(h.session).toHaveBeenCalledTimes(2); expect(h.chain).toHaveBeenCalledTimes(2);   // mutable state stays fresh
    const snap = m.snapshot();
    expect(snap.targetCurveOfMiss).toBe(1); expect(snap.targetCurveMetaMiss).toBe(1);
    expect("targetCurveOf" in snap && "targetCurveMeta" in snap).toBe(true);
    // a DIFFERENT registered curve for the token is read fresh and still has to match the token
    admissionImmutableCache.clear(); h.curveOf.mockResolvedValue("0x0000000000000000000000000000000000000044");
    h.curveInfo.mockResolvedValue({ token: sender, quote: usdg, graduated: false });
    await expect(admitRelay(op())).rejects.toThrow(); expect(h.curveInfo).toHaveBeenCalledTimes(2);
  });
  it("never caches zero/invalid registry or metadata results, or failed reads", async () => {
    h.curveOf.mockResolvedValueOnce("0x0000000000000000000000000000000000000000");
    await expect(admitRelay(op())).rejects.toThrow(); await admitRelay(op());
    expect(h.curveOf).toHaveBeenCalledTimes(2);
    admissionImmutableCache.clear(); vi.clearAllMocks();
    h.curveInfo.mockResolvedValueOnce({ token: "0x0000000000000000000000000000000000000000", quote: usdg, graduated: false });
    await expect(admitRelay(op())).rejects.toThrow(); await admitRelay(op()); expect(h.curveInfo).toHaveBeenCalledTimes(2);
    admissionImmutableCache.clear(); vi.clearAllMocks();
    h.curveInfo.mockRejectedValueOnce(new Error("rpc down"));
    await expect(admitRelay(op())).rejects.toThrow("rpc down"); await admitRelay(op()); expect(h.curveInfo).toHaveBeenCalledTimes(2);
  });
  it("the cached projection never carries graduated, and the cache is per-instance with a 1 h TTL / 256 cap", async () => {
    h.curveInfo.mockResolvedValue({ token, quote: usdg, graduated: true });
    await admitRelay(op());
    const meta = await admissionImmutableCache.get(`46630:curvemeta:${DEPLOYMENTS[46630].launchpad.toLowerCase()}:0x0000000000000000000000000000000000000033`, async () => { throw new Error("must be cached"); }, () => true);
    expect(meta).toEqual({ token, quote: usdg });
    expect(ADMISSION_CACHE_TTL_MS).toBe(3_600_000);
    let now = 0; const c = new ImmutableRelayCache(ADMISSION_CACHE_TTL_MS, () => now), read = vi.fn().mockResolvedValue("x");
    await c.get("k", read, () => true); now = ADMISSION_CACHE_TTL_MS - 1; await c.get("k", read, () => true); expect(read).toHaveBeenCalledTimes(1);
    now = ADMISSION_CACHE_TTL_MS; await c.get("k", read, () => true); expect(read).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 300; i++) await c.get(`e${i}`, async () => i, () => true);
    const first = vi.fn().mockResolvedValue("again"); await c.get("e0", first, () => true); expect(first).toHaveBeenCalledOnce();
  });
  it("relayCaps keeps its own fresh reads: chainGradReads.curveInfo (graduated) is uncached; curveMeta reads only token/quote", async () => {
    const multicall = vi.fn().mockResolvedValue([token, usdg]);
    const r = (await vi.importActual<typeof import("../lib/server/gradBuy")>("../lib/server/gradBuy")).chainGradReads({ multicall } as never, 46630);
    expect(await r.curveMeta!("0x0000000000000000000000000000000000000033")).toEqual({ token, quote: usdg });
    expect((multicall.mock.calls[0][0] as { contracts: { functionName: string }[] }).contracts.map(c => c.functionName)).toEqual(["token", "quote"]);
    multicall.mockResolvedValue([token, usdg, true]);
    await r.curveInfo("0x0000000000000000000000000000000000000033"); await r.curveInfo("0x0000000000000000000000000000000000000033");
    expect(multicall).toHaveBeenCalledTimes(3);   // graduated path re-reads every time
  });
  it("re-encoding and selector checks still run on cached metadata", async () => {
    await admitRelay(op());   // warm cache
    const bad = { ...op(), callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [[{ target: usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sender, 1n] }) }]] }) };
    await expect(admitRelay(bad)).rejects.toThrow();
    const cs = calls(); cs[0].data = encodeFunctionData({ abi: erc20, functionName: "approve", args: [router, 11n] });   // unpaired amount
    await expect(admitRelay({ ...op(), callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [cs] }) })).rejects.toThrow();
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
    // Vercel Security finding 1: one atomic budget call (sender cap checked first); 1 = sender over cap, 2 = global over cap
    h.budget.mockResolvedValue(1); await expect(relaySendBudget(sender)).rejects.toThrow("rate limited");
    h.budget.mockResolvedValue(2); await expect(relaySendBudget(sender)).rejects.toThrow("rate limited");
    expect(h.budget).toHaveBeenLastCalledWith(`relay:paid:sender:${sender.toLowerCase()}`, "relay:paid:global", 20, 60, 60);
    h.budget.mockRejectedValue(new Error("store offline")); await expect(relaySendBudget(sender)).rejects.toThrow("store offline");
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
    expect(h.chain).toHaveBeenCalledTimes(3); expect(h.session).toHaveBeenCalledTimes(3);
    expect(h.curveInfo).toHaveBeenCalledTimes(2);   // (c): baseline + cold; warm serves immutable token/quote from the per-instance cache
    console.info("LOCAL_RELAY_BENCHMARK " + JSON.stringify({ rttModelMs: 80, beforeAdmission: before, afterColdAdmission: cold, afterWarmAdmission: warm, afterCold: coldSnapshot, afterWarm: warmMetrics.snapshot(), basis: "deterministic mocked read RTT; no chain ops" }));
  } finally { vi.useRealTimers(); }
});

// Safety experiment for the proposed read-only speculation: the existing actual
// admission/lease gate remains authoritative even if a caller's eth_call finished.
// This does NOT wire speculative simulation into production or permit result reuse.
describe("late admission failure cannot be overridden by successful read-only speculation", () => {
  for (const gate of ["login", "session", "target"] as const) it(`${gate} fails after simulation: notSent, no lease/budget/nonce/sign/send`, async () => {
    let deny!: () => void;
    if (gate === "login") h.read.mockImplementation(({ functionName }) => functionName === "verifiedUntil"
      ? new Promise<bigint>(resolve => { deny = () => resolve(0n); })
      : Promise.resolve(functionName === "moduleId" ? "disciple.session-policy.1.4.3" : pm));
    if (gate === "session") h.session.mockImplementation(() => new Promise(resolve => { deny = () => resolve({ active: false, validUntil: 1000 }); }));
    if (gate === "target") h.curveInfo.mockImplementation(() => new Promise(resolve => { deny = () => resolve({ token: sender, quote: usdg, graduated: false }); }));
    const sim = vi.fn().mockResolvedValue("0x"), sign = vi.fn(), broadcast = vi.fn(), nonce = vi.fn();
    const speculative = authorizeRelayOperation(op(), reads(), sim);
    const guarded = lockedRelay(op(), async () => { await speculative; await relaySendBudget(sender); nonce(); sign(); broadcast(); });
    const rejected = expect(guarded).rejects.toMatchObject({ notSent: true });
    await speculative; await vi.waitFor(() => expect(deny).toBeTypeOf("function"));
    expect(sim).toHaveBeenCalledOnce(); expect(h.set).not.toHaveBeenCalled();
    deny(); await rejected;
    expect(h.set).not.toHaveBeenCalled(); expect(h.incr).not.toHaveBeenCalled(); expect(h.budget).not.toHaveBeenCalled();
    expect(nonce).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
  });
});

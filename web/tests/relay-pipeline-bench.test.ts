/**
 * LOCAL relay pipeline benchmark (no chain ops, no network). Runs the REAL sendUserOperationSync → lockedRelay →
 * admission / simulation / fence / commit wiring with every RPC / KV / send mocked at latencies drawn from the measured
 * Nov 9 Preview spans (self-bundler-speed1/timings.json). Same seeded latency + cold/warm-instance sequence for any tree,
 * so before (94dec1af) and after are compared like for like. Opt-in: RELAY_BENCH=1 (skipped in the normal suite).
 */
import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { encodeFunctionData, pad, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
const h = vi.hoisted(() => { process.env.NEXT_PUBLIC_CHAIN_ID = "46630"; return { lat: (_k: string) => Promise.resolve() } as { lat: (k: string) => Promise<void> }; });
const wait = (k: string) => h.lat(k);
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({
  getChainId: async () => { await wait("rpc"); return 46630; },
  getBlock: async () => { await wait("rpc"); return { timestamp: 100n, baseFeePerGas: 1n }; },
  readContract: async ({ functionName }: { functionName: string }) => { await wait("rpc");
    if (functionName === "getNonce") return NONCE; if (functionName === "verifiedUntil") return 1000n;
    if (functionName === "moduleId") return "disciple.session-policy.1.4.3";
    if (functionName === "SEMI_MODULAR_ACCOUNT_IMPL" || functionName === "ACCOUNT_IMPLEMENTATION") return impl; return pm; },
  call: async ({ to }: { to: string }) => { if (to.toLowerCase() === "0x00000000000000000000000000000000000000c8") { await wait("rpc"); throw new Error("no node interface"); } await wait("sim"); return { data: "0x" }; },
  getCode: async () => { await wait("rpc"); return `${ACCOUNT_PROXY_RUNTIME}${sender.slice(2)}`; },
  getStorageAt: async () => { await wait("rpc"); return pad(impl, { size: 32 }); },
  getTransactionCount: async () => { await wait("rpc"); return 5; }, getBalance: async () => { await wait("rpc"); return 0n; },
}) }));
vi.mock("@disciple/session-keys", async original => ({ ...await original<typeof import("@disciple/session-keys")>(), readSession: async () => { await wait("rpc"); return { active: true, validUntil: 1000 }; } }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({
  mget: async (ks: string[]) => { await wait(ks[0].startsWith("relay:leasegen:") ? "kvSnap" : "kvGate"); return ks[0].startsWith("relay:leasegen:") ? ["4", null] : ks.map(() => null); },
  nonceAlloc: async () => { await wait("kvGen"); return 4; }, setNX: async () => { await wait("kvSet"); return true; },
  delIfEq: async () => { await wait("kvDel"); return true; }, incrEx: async () => { await wait("kvIncr"); return 1; },
  // one EVAL replacing the two parallel INCRs; modeled conservatively as the max of two kvIncr draws (same RNG use)
  relayBudget: async () => { await Promise.all([wait("kvIncr"), wait("kvIncr")]); return 0; }, decrIfPositive: async () => { await wait("kvIncr"); return 0; }, ttl: async () => -2,
}) }));
vi.mock("../lib/server/gradBuy", async original => ({ ...await original<typeof import("../lib/server/gradBuy")>(), chainGradReads: () => ({
  router: "0x688160633b22012717661545df6299d3d3174ad2", usdg: "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d",
  curveOf: async () => { await wait("rpc"); return "0x0000000000000000000000000000000000000033"; },
  curveInfo: async () => { await wait("rpc"); return { token, quote: usdg, graduated: false }; } }) }));
let depositCalls = 0;
vi.mock("../lib/server/paymasterDeposit", () => ({ allowedPaymaster: () => "0x5C3f7400ED41aCd7409D213caB2909e3b1E31136",
  paymasterDepositCached: async () => { if (depositCalls++ === 0) await wait("rpc"); return 10n ** 18n; }, debitPaymasterDeposit: () => undefined }));
vi.mock("../lib/server/relayer", () => ({ relayerKey: () => KEY, relayerIsFaucet: () => false }));
vi.mock("../lib/server/relayTrustStore", () => ({ kvTrustStore: () => ({ load: async () => null, save: async () => undefined, claimFirstPrime: async () => false }) }));
vi.mock("../lib/server/syncSend", async original => ({ ...await original<typeof import("../lib/server/syncSend")>(),
  syncSend: async () => { await wait("send"); return { rc: receipt, via: "sync", sendMs: 1, minedMs: 0, pending: false }; }, jsonRpc: () => async () => null }));
const KEY = generatePrivateKey();
process.env.RELAYER_NONCE_SHARED = "0";
import { sendUserOperationSync } from "../lib/server/fastRelay";
import { admissionImmutableCache } from "../lib/server/relayLockdown";
import { ACCOUNT_PROXY_RUNTIME } from "../lib/server/relayAuth";
import type { UserOp } from "../lib/aa/core";

const sender = "0x0000000000000000000000000000000000000011" as Address, pm = "0x5C3f7400ED41aCd7409D213caB2909e3b1E31136" as Address;
const impl = "0x00000000000000000000000000000000000000aa" as Address, token = "0x0000000000000000000000000000000000000022" as Address;
const router = "0x688160633b22012717661545df6299d3d3174ad2" as Address, usdg = "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d" as Address;
const NONCE = ((7n << 8n) << 64n) | 3n;
const exec = parseAbi(["function executeBatch((address target,uint256 value,bytes data)[])"]), erc20 = parseAbi(["function approve(address,uint256)"]);
const buy = parseAbi(["function buyWithUsdg(address,uint256,uint256,uint256)"]);
const receipt = { transactionHash: `0x${"ab".repeat(32)}` as Hex, blockHash: `0x${"cd".repeat(32)}` as Hex, blockNumber: "0x1", status: "0x1", gasUsed: "0x1", logs: [] };
const op = (): UserOp => ({ sender, nonce: `0x${NONCE.toString(16)}`, signature: "0x1234",
  callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [[
    { target: usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [router, 10n] }) },
    { target: router, value: 0n, data: encodeFunctionData({ abi: buy, functionName: "buyWithUsdg", args: [token, 10n, 1n, 150n] }) }]] }),
  callGasLimit: "0x100000", verificationGasLimit: "0x40000", preVerificationGas: "0x10000", maxFeePerGas: "0x2000000", maxPriorityFeePerGas: "0xf4240",
  paymaster: pm, paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x30000", paymasterData: "0x" } as unknown as UserOp);

// Seeded PRNG (mulberry32): identical latency and cold/warm sequence for every tree.
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
// ms ranges from the measured Nov 9 spans: reads 101–156 (authLogin/sessionRead/leaseRecheckReads), simulate 104–194,
// syncSend 159–305, freshnessSnapshot 16–17, leaseAcquire 3–12, leaseGeneration 3–10, rateLimitStore 11–40.
const RANGES: Record<string, [number, number, number?, number?]> = {   // [lo, hi, tailProb, tailHi]
  rpc: [98, 125, 0.15, 160], sim: [102, 125, 0.17, 195], send: [159, 305], kvSnap: [15, 18], kvSet: [3, 12], kvGen: [3, 10], kvIncr: [10, 40], kvDel: [3, 6], kvGate: [8, 16],
};
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
describe.skipIf(!process.env.RELAY_BENCH)("relay pipeline benchmark (mocked RPC latencies)", () => {
  it("request→receipt server wall, N trials", async () => {
    process.env.GAS_SPONSORSHIP_MODE = "self"; process.env.NEXT_PUBLIC_SESSION_POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2";
    delete process.env.VERCEL_ENV; delete process.env.VERCEL;
    const N = Number(process.env.RELAY_BENCH_N ?? 60), rand = rng(20261109), cold = rng(4663), rows: { ms: number; cold: boolean }[] = [];
    h.lat = (k: string) => { const [lo, hi, tp, th] = RANGES[k]; const ms = tp && rand() < tp ? hi + rand() * ((th ?? hi) - hi) : lo + rand() * (hi - lo); return new Promise(r => setTimeout(r, ms)); };
    for (let i = 0; i < N + 3; i++) {
      // 4/6 measured trades missed the per-instance curveOf cache (cold / different instance) ⇒ p(cold) = 0.6.
      const isCold = cold() < 0.6; if (isCold) admissionImmutableCache.clear(); depositCalls = 0;
      const t = performance.now(); const r = await sendUserOperationSync(op()); const ms = performance.now() - t;
      expect(r.kind).toBe("confirmed");
      if (i >= 3) rows.push({ ms, cold: isCold });   // 3 warm-up trials discarded
    }
    const sum = (xs: number[]) => ({ n: xs.length, median: Math.round(pct(xs, 0.5)), p95: Math.round(pct(xs, 0.95)), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)) });
    const out = { tree: process.env.RELAY_BENCH_TREE, all: sum(rows.map(r => r.ms)), coldInstance: sum(rows.filter(r => r.cold).map(r => r.ms)), warmInstance: sum(rows.filter(r => !r.cold).map(r => r.ms)) };
    console.info("RELAY_BENCH " + JSON.stringify(out));
    if (process.env.RELAY_BENCH_OUT) writeFileSync(process.env.RELAY_BENCH_OUT, JSON.stringify(out, null, 1));
  }, 600_000);
});

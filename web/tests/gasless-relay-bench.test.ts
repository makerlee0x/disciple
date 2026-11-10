/**
 * LOCAL gasless (Permit2 witness) relay benchmark: same seeded latency model, RANGES and cold/warm sequence as
 * relay-pipeline-bench.test.ts (815af744), so `RELAY_BENCH=1` compares old (4337 self-bundler) and new like for like.
 * Runs the REAL relayGaslessTrade: parse → check → local signature recovery → parallel admission (Privy session ∥
 * revoke/strike ∥ relayer state ∥ exact eth_call; sim starts with the relayer, not after the gate) → budget →
 * direct sync send. Opt-in: RELAY_BENCH=1.
 * Off-chain login (AUDIT M2): a real ES256 Privy *identity token* (linked_accounts in the JWT) is verified each request
 * (local crypto only — no api.privy.io users hop). Cold/warm flips in-memory caches; the immutable market status
 * lives in the shared KV (same MGET as the ban/strike gate), so a cold instance does not re-read curveOf.
 */
import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const h = vi.hoisted(() => { process.env.NEXT_PUBLIC_CHAIN_ID = "46630"; process.env.NEXT_PUBLIC_RHT_GASLESS_ROUTER = "0x00000000000000000000000000000000000000bb";
  return { lat: (_k: string) => Promise.resolve() as Promise<void>, market: new Map<string, string>() }; });
const wait = (k: string) => h.lat(k);
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({
  getChainId: async () => { await wait("rpc"); return 46630; },
  getBlock: async () => { await wait("rpc"); return { timestamp: 100n, baseFeePerGas: 1n }; },
  readContract: async ({ functionName }: { functionName: string }) => { await wait("rpc"); return functionName === "verifiedUntil" ? 1000n : 0n; },
  call: async () => { await wait("sim"); return { data: "0x" }; },
  getTransactionCount: async () => { await wait("rpc"); return 5; }, getBalance: async () => { await wait("rpc"); return 0n; },
}) }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({
  mget: async (ks: string[]) => { await wait(ks[0].startsWith("relay:leasegen:") ? "kvSnap" : "kvGate"); return ks[0].startsWith("relay:leasegen:") ? ["4", null] : ks.map(k => h.market.get(k) ?? null); },
  set: async (k: string, v: string) => { h.market.set(k, v); },
  nonceAlloc: async () => { await wait("kvGen"); return 4; }, setNX: async () => { await wait("kvSet"); return true; }, get: async () => null,
  delIfEq: async () => { await wait("kvDel"); return true; }, incrEx: async () => { await wait("kvIncr"); return 1; }, incrByEx: async () => 0,
  relayBudget: async () => { await Promise.all([wait("kvIncr"), wait("kvIncr")]); return 0; }, decrIfPositive: async () => { await wait("kvIncr"); return 0; }, ttl: async () => -2,
}) }));
vi.mock("../lib/server/relayer", () => ({ relayerKey: () => KEY, relayerIsFaucet: () => false }));
vi.mock("../lib/server/relayTrustStore", () => ({ kvTrustStore: () => ({ load: async () => null, save: async () => undefined, claimFirstPrime: async () => false }) }));
vi.mock("../lib/server/syncSend", async original => ({ ...await original<typeof import("../lib/server/syncSend")>(),
  syncSend: async () => { await wait("send"); return { rc: receipt, via: "sync", sendMs: 1, minedMs: 0, pending: false }; }, jsonRpc: () => async () => null }));
const KEY = generatePrivateKey();
process.env.RELAYER_NONCE_SHARED = "0";
import { relayGaslessTrade, gaslessMarketCache } from "../lib/server/gaslessRelay";
import { admissionImmutableCache } from "../lib/server/relayLockdown";
import { tradeTypedData } from "../lib/trade/gaslessPermit2";
import { gaslessSessionDeps } from "../lib/server/gaslessSession";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
const { privateKey: SK, publicKey: PK } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwt = (sub: string) => { const n = Math.floor(Date.now() / 1000), e = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const accounts = JSON.stringify([{ type: "email", address: "a@b.co" }, { type: "wallet", chain_type: "ethereum", address: user.address, wallet_client_type: "privy" }]);
  const hb = `${e({ alg: "ES256", typ: "JWT" })}.${e({ iss: "privy.io", aud: "benchapp01", sub, iat: n, exp: n + 3600, linked_accounts: accounts })}`;
  return `${hb}.${cryptoSign("sha256", Buffer.from(hb), { key: SK, dsaEncoding: "ieee-p1363" }).toString("base64url")}`; };

const user = privateKeyToAccount(generatePrivateKey()), router = "0x00000000000000000000000000000000000000bb" as Address;
const usdg = "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d" as Address, coin = "0x0000000000000000000000000000000000000022" as Address;
const receipt = { transactionHash: `0x${"ab".repeat(32)}`, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", status: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [] };
async function signed(nonce: bigint) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 250);
  const trade = { coin, isBuy: true, amountIn: 3_000_000n, minOut: 1n, recipient: user.address, deadline };
  const permit = { permitted: { token: usdg, amount: 3_000_000n }, nonce, deadline };
  const signature = await user.signTypedData(tradeTypedData(46630, router, permit, trade));
  return JSON.parse(JSON.stringify({ signer: user.address, permit, trade, signature }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const RANGES: Record<string, [number, number, number?, number?]> = {   // identical to relay-pipeline-bench.test.ts
  privy: [98, 125, 0.15, 160],
  rpc: [98, 125, 0.15, 160], sim: [102, 125, 0.17, 195], send: [159, 305], kvSnap: [15, 18], kvSet: [3, 12], kvGen: [3, 10], kvIncr: [10, 40], kvDel: [3, 6], kvGate: [8, 16],
};
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
describe.skipIf(!process.env.RELAY_BENCH)("gasless relay benchmark (mocked RPC latencies)", () => {
  it("request→receipt server wall, N trials", async () => {
    process.env.GAS_SPONSORSHIP_MODE = "gasless"; delete process.env.VERCEL_ENV; delete process.env.VERCEL;
    const N = Number(process.env.RELAY_BENCH_N ?? 60), rand = rng(20261109), cold = rng(4663), rows: { ms: number; cold: boolean }[] = [];
    h.lat = (k: string) => { const [lo, hi, tp, th] = RANGES[k]; const ms = tp && rand() < tp ? hi + rand() * ((th ?? hi) - hi) : lo + rand() * (hi - lo); return new Promise(r => setTimeout(r, ms)); };
    gaslessSessionDeps.env = () => ({ appId: "benchapp01", appSecret: "x", verificationKey: PK.export({ type: "spki", format: "pem" }).toString() });
    gaslessSessionDeps.invite = async () => ({ ok: true });
    gaslessSessionDeps.fetch = (async (url: string) => { await wait("privy"); const id = decodeURIComponent(url.split("/users/")[1]);
      return { ok: true, status: 200, json: async () => ({ id, linked_accounts: [{ type: "email", address: "a@b.co" }, { type: "wallet", chain_type: "ethereum", address: user.address }] }) }; }) as never;
    let did = "did:privy:bench00000000";
    for (let i = 0; i < N + 3; i++) {
      const isCold = cold() < 0.6; if (isCold) { admissionImmutableCache.clear(); gaslessMarketCache.clear(); did = `did:privy:bench${String(i).padStart(8, "0")}`; }
      const body = await signed(BigInt(i));   // client-side signing is not server wall
      const idToken = jwt(did);
      const t = performance.now(); const r = await relayGaslessTrade(body, { idToken }); const ms = performance.now() - t;
      expect(r.kind).toBe("confirmed");
      if (i >= 3) rows.push({ ms, cold: isCold });
    }
    const sum = (xs: number[]) => ({ n: xs.length, median: Math.round(pct(xs, 0.5)), p95: Math.round(pct(xs, 0.95)), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)) });
    const out = { tree: process.env.RELAY_BENCH_TREE ?? "gasless", all: sum(rows.map(r => r.ms)), coldInstance: sum(rows.filter(r => r.cold).map(r => r.ms)), warmInstance: sum(rows.filter(r => !r.cold).map(r => r.ms)) };
    console.info("RELAY_BENCH " + JSON.stringify(out));
    if (process.env.RELAY_BENCH_OUT) writeFileSync(process.env.RELAY_BENCH_OUT, JSON.stringify(out, null, 1));
  }, 600_000);
});

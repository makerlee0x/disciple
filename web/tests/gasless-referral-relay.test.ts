/** Referral attach hooked into relayGaslessTrade: same MGET, never blocks or strikes the trade. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { Address, Hex } from "viem";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  process.env.NEXT_PUBLIC_RHT_GASLESS_ROUTER = "0x00000000000000000000000000000000000000bb";
  return { chain: vi.fn(), block: vi.fn(), read: vi.fn(), call: vi.fn(), count: vi.fn(), balance: vi.fn(), incr: vi.fn(), mget: vi.fn(), budget: vi.fn(), refund: vi.fn(), send: vi.fn(), setNX: vi.fn(), set: vi.fn(), get: vi.fn(), incrBy: vi.fn() };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ getChainId: h.chain, getBlock: h.block, readContract: h.read, call: h.call, getTransactionCount: h.count, getBalance: h.balance }) }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({ incrEx: h.incr, mget: h.mget, relayBudget: h.budget, decrIfPositive: h.refund, setNX: h.setNX, set: h.set, get: h.get, incrByEx: h.incrBy, ttl: async () => -2 }) }));
vi.mock("../lib/server/relayer", () => ({ relayerKey: () => KEY, relayerIsFaucet: () => false }));
vi.mock("../lib/server/relayTrustStore", () => ({ kvTrustStore: () => ({ load: async () => null, save: async () => undefined, claimFirstPrime: async () => false }) }));
vi.mock("../lib/server/syncSend", async original => ({ ...await original<typeof import("../lib/server/syncSend")>(), syncSend: h.send, jsonRpc: () => async () => null }));
const KEY = generatePrivateKey();
process.env.RELAYER_NONCE_SHARED = "0";
import { relayGaslessTrade, type GaslessDeps } from "../lib/server/gaslessRelay";
import { gaslessSessionDeps } from "../lib/server/gaslessSession";
import { gaslessReferralHooks, referralDoneKey, REFERRAL_DONE } from "../lib/server/gaslessReferral";
import { tradeTypedData } from "../lib/trade/gaslessPermit2";
import { DEPLOYMENTS } from "../lib/chains";
import { strikeSource } from "../lib/server/relayLockdown";

const user = privateKeyToAccount(generatePrivateKey());
const referrer = "0x00000000000000000000000000000000000000b2" as Address;
const APP = "testapp0001";
const { privateKey: PRIVY_SK, publicKey: PRIVY_PK } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64u = (x: Buffer | string) => Buffer.from(x).toString("base64url");
let didSeq = 0;
function jwt(sub: string, accounts: string) {
  const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: "privy.io", aud: APP, sub, sid: "s1", iat: NOW - 10, exp: NOW + 3600, linked_accounts: accounts }));
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), { key: PRIVY_SK, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}
function session(wallets: string[]) {
  const did = `did:privy:reftest${String(++didSeq).padStart(6, "0")}`;
  const accounts = JSON.stringify([
    { type: "email", address: "a@b.co" },
    ...wallets.map(address => ({ type: "wallet", chain_type: "ethereum", address, wallet_client_type: "privy" })),
  ]);
  return { did, token: jwt(did, accounts) };
}
let TOKEN = "";
const relay = (b: unknown, d: GaslessDeps = {}) => relayGaslessTrade(b, { idToken: TOKEN, ...d });
const router = DEPLOYMENTS[46630].gaslessRouter, usdg = DEPLOYMENTS[46630].usdg;
const coin = "0x00000000000000000000000000000000000000c0" as Address;
const NOW = Math.floor(Date.now() / 1000);
const okRc = () => ({ rc: { transactionHash: `0x${"ab".repeat(32)}` as Hex, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", status: "0x1", gasUsed: "0x30d40", effectiveGasPrice: "0x1312d00", logs: [] }, via: "sync", sendMs: 5, minedMs: 0, pending: false });
async function wire(o: { referrer?: Address } = {}) {
  const deadline = BigInt(NOW + 120), amountIn = 3_000_000n;
  const trade = { coin, isBuy: true, amountIn, minOut: 1n, recipient: user.address, deadline };
  const permit = { permitted: { token: usdg, amount: amountIn }, nonce: 7n, deadline };
  const signature = await user.signTypedData(tradeTypedData(46630, router, permit, trade));
  return JSON.parse(JSON.stringify({ signer: user.address, permit, trade, signature, ...(o.referrer ? { referrer: o.referrer } : {}) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
const origAfter = gaslessReferralHooks.after, origAttach = gaslessReferralHooks.attach;
beforeEach(() => {
  vi.resetAllMocks(); delete process.env.VERCEL_ENV; delete process.env.VERCEL; process.env.GAS_SPONSORSHIP_MODE = "gasless";
  h.chain.mockResolvedValue(46630); h.block.mockResolvedValue({ timestamp: BigInt(NOW), baseFeePerGas: 10_000_000n });
  h.read.mockResolvedValue(0n); h.call.mockResolvedValue({ data: "0x" }); h.count.mockResolvedValue(5); h.balance.mockResolvedValue(0n);
  h.incr.mockResolvedValue(1); h.mget.mockImplementation(async (ks: string[]) => ks.map(() => null)); h.budget.mockResolvedValue(0); h.refund.mockResolvedValue(0);
  h.send.mockResolvedValue(okRc()); h.setNX.mockResolvedValue(true); h.set.mockResolvedValue(undefined); h.get.mockResolvedValue(null); h.incrBy.mockResolvedValue(1);
  strikeSource.local = () => 0;
  gaslessSessionDeps.env = () => ({ appId: APP, appSecret: "test-secret", verificationKey: PRIVY_PK.export({ type: "spki", format: "pem" }).toString() });
  gaslessSessionDeps.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as never;
  gaslessSessionDeps.invite = async () => ({ ok: true });
  TOKEN = session([user.address]).token;
  gaslessReferralHooks.after = origAfter;
  gaslessReferralHooks.attach = origAttach;
});
afterEach(() => { gaslessReferralHooks.after = origAfter; gaslessReferralHooks.attach = origAttach; vi.unstubAllEnvs(); });

describe("relay hook", () => {
  it("includes relay:ref:{wallet} in the same gate MGET as ban/strike/revoke", async () => {
    await relay(await wire());
    const gateCalls = (h.mget.mock.calls as unknown as [string[]][]).filter(c => c[0].some(k => k.startsWith("relay:banned:") || k.startsWith("relay:trust:")));
    expect(gateCalls.length).toBeGreaterThan(0);
    expect(gateCalls[0][0]).toContain(referralDoneKey(user.address));
  });
  it("schedules attach after a successful trade when a referrer is present and not done, without awaiting it", async () => {
    let finish!: () => void;
    const held = new Promise<void>(r => { finish = r; });
    let started = false, finished = false, attachArgs: unknown;
    gaslessReferralHooks.after = (task) => { void Promise.resolve().then(task); };
    gaslessReferralHooks.attach = async (o) => { started = true; attachArgs = o; await held; finished = true; return "attached"; };
    const t0 = Date.now();
    const r = await relay(await wire({ referrer }));
    const elapsed = Date.now() - t0;
    expect(r.success).toBe(true);
    expect(started).toBe(true);
    expect(finished).toBe(false);
    expect(elapsed).toBeLessThan(200);
    expect(attachArgs).toMatchObject({ trader: user.address, referrer, alreadyDone: null });
    finish();
    await held;
    expect(finished).toBe(true);
  });
  it("does not attach when there is no referrer, or when relay:ref is already done", async () => {
    const attach = vi.fn(async () => "attached" as const);
    gaslessReferralHooks.attach = attach;
    gaslessReferralHooks.after = (task) => { void Promise.resolve().then(task); };
    await relay(await wire());
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();
    h.mget.mockImplementation(async (ks: string[]) => ks.map(k => k === referralDoneKey(user.address) ? REFERRAL_DONE : null));
    await relay(await wire({ referrer }));
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();
  });
  it("a failed attach does not strike; the next trade is admitted", async () => {
    gaslessReferralHooks.after = (task) => { void Promise.resolve().then(task).catch(() => undefined); };
    gaslessReferralHooks.attach = async () => { throw new Error("attestor send failed"); };
    await expect(relay(await wire({ referrer }))).resolves.toMatchObject({ success: true });
    await Promise.resolve();
    gaslessReferralHooks.attach = async () => "skipped";
    await expect(relay(await wire())).resolves.toMatchObject({ success: true });
  });
});

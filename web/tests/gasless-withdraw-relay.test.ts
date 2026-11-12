/** flow/gasless-withdraw relay: same Privy/revoke/strike gate as trades, Multicall3 submit, no-strike on relayer-side failure. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseTransaction, toBytes, keccak256, slice, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  process.env.NEXT_PUBLIC_RHT_GASLESS_ROUTER = "0x00000000000000000000000000000000000000bb";
  process.env.PAYMASTER_USD_PER_ETH = "2300";
  return { chain: vi.fn(), block: vi.fn(), read: vi.fn(), call: vi.fn(), count: vi.fn(), balance: vi.fn(), incr: vi.fn(), mget: vi.fn(), budget: vi.fn(), refund: vi.fn(), send: vi.fn(), setNX: vi.fn(), set: vi.fn(), get: vi.fn(), incrBy: vi.fn() };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ getChainId: h.chain, getBlock: h.block, readContract: h.read, call: h.call, getTransactionCount: h.count, getBalance: h.balance }) }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({ incrEx: h.incr, mget: h.mget, relayBudget: h.budget, decrIfPositive: h.refund, setNX: h.setNX, set: h.set, get: h.get, incrByEx: h.incrBy, ttl: async () => -2 }) }));
vi.mock("../lib/server/relayer", () => ({ relayerKey: () => KEY, relayerIsFaucet: () => false }));
vi.mock("../lib/server/relayTrustStore", () => ({ kvTrustStore: () => ({ load: async () => null, save: async () => undefined, claimFirstPrime: async () => false }) }));
vi.mock("../lib/server/syncSend", async original => ({ ...await original<typeof import("../lib/server/syncSend")>(), syncSend: h.send, jsonRpc: () => async () => null }));
const KEY = generatePrivateKey();
process.env.RELAYER_NONCE_SHARED = "0";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { relayGaslessWithdraw, quoteGaslessWithdraw, withdrawFeeTo, withdrawUsdgPerEth } from "../lib/server/gaslessWithdrawRelay";
import { gaslessSessionDeps } from "../lib/server/gaslessSession";
import { strikeSource } from "../lib/server/relayLockdown";
import { MULTICALL3, multicall3Abi, transferTypedData, WITHDRAW_TX_GAS_LIMIT, withdrawFeeRaw, withdrawGas } from "../lib/trade/gaslessWithdraw";
import { DEPLOYMENTS } from "../lib/chains";
import type { GaslessDeps } from "../lib/server/gaslessRelay";

const user = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const APP = "testapp0001";
const { privateKey: PRIVY_SK, publicKey: PRIVY_PK } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64u = (x: Buffer | string) => Buffer.from(x).toString("base64url");
let didSeq = 0;
function jwt(sub: string, o: { exp?: number; aud?: string; key?: typeof PRIVY_SK; accounts?: string } = {}) {
  const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: "privy.io", aud: o.aud ?? APP, sub, sid: "s1", iat: NOW - 10, exp: o.exp ?? NOW + 3600, linked_accounts: o.accounts ?? "[]" }));
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), { key: o.key ?? PRIVY_SK, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}
function session(wallets: string[], logins: string[] = ["email"], o: Parameters<typeof jwt>[1] = {}) {
  const did = `did:privy:tester${String(++didSeq).padStart(6, "0")}`;
  const accounts = JSON.stringify([
    ...logins.map(type => type === "google_oauth" ? { type, email: "a@b.co" } : { type, address: "a@b.co" }),
    ...wallets.map(address => ({ type: "wallet", chain_type: "ethereum", address, wallet_client_type: "privy" })),
  ]);
  return { did, token: jwt(did, { ...o, accounts }) };
}
const privyFetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
let TOKEN = "";
const relay = (b: unknown, d: GaslessDeps = {}) => relayGaslessWithdraw(b, { idToken: TOKEN, ...d });
const usdg = DEPLOYMENTS[46630].usdg;
const dest = "0x00000000000000000000000000000000000000dd" as Address;
const NOW = Math.floor(Date.now() / 1000);
const BASE = 11_100_000n;
const errSel = (sig: string) => slice(keccak256(toBytes(sig)), 0, 4);
const okRc = (status = "0x1") => ({ rc: { transactionHash: `0x${"ab".repeat(32)}` as Hex, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", status, gasUsed: "0x30d40", effectiveGasPrice: "0x1312d00", logs: [] }, via: "sync", sendMs: 5, minedMs: 0, pending: false });
const feeTo = () => withdrawFeeTo();
function feeNow(needsPermit = false) {
  return withdrawFeeRaw(withdrawGas(needsPermit), BASE, withdrawUsdgPerEth(), DEPLOYMENTS[46630].usdgDecimals);
}
async function wire(o: { signer?: typeof user; amount?: bigint; fee?: bigint; dest?: Address } = {}) {
  const s = o.signer ?? user, fee = o.fee ?? feeNow(), amount = o.amount ?? fee + 1_000_000n, deadline = BigInt(NOW + 120);
  const netPermit = { permitted: { token: usdg, amount: amount - fee }, nonce: 0n, deadline };
  const feePermit = { permitted: { token: usdg, amount: fee }, nonce: 1n, deadline };
  return JSON.parse(JSON.stringify({
    signer: s.address, destination: o.dest ?? dest, amount, fee, feeTo: feeTo(),
    netPermit, feePermit,
    netSignature: await s.signTypedData(transferTypedData(46630, netPermit)),
    feeSignature: await s.signTypedData(transferTypedData(46630, feePermit)),
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
beforeEach(() => {
  vi.resetAllMocks(); delete process.env.VERCEL_ENV; delete process.env.VERCEL; process.env.GAS_SPONSORSHIP_MODE = "gasless";
  process.env.PAYMASTER_USD_PER_ETH = "2300";
  h.chain.mockResolvedValue(46630); h.block.mockResolvedValue({ timestamp: BigInt(NOW), baseFeePerGas: BASE });
  h.read.mockResolvedValue(0n); h.call.mockResolvedValue({ data: "0x" }); h.count.mockResolvedValue(5); h.balance.mockResolvedValue(10n ** 18n);
  h.incr.mockResolvedValue(1); h.mget.mockImplementation(async (ks: string[]) => ks.map(() => null)); h.budget.mockResolvedValue(0); h.refund.mockResolvedValue(0);
  h.send.mockResolvedValue(okRc()); h.setNX.mockResolvedValue(true); h.set.mockResolvedValue(undefined); h.get.mockResolvedValue(null); h.incrBy.mockResolvedValue(1);
  strikeSource.local = () => 0;
  gaslessSessionDeps.env = () => ({ appId: APP, appSecret: "test-secret", verificationKey: PRIVY_PK.export({ type: "spki", format: "pem" }).toString() });
  gaslessSessionDeps.fetch = privyFetch as never;
  gaslessSessionDeps.invite = async () => ({ ok: true });
  TOKEN = session([user.address, other.address]).token;
});
afterEach(() => vi.unstubAllEnvs());

describe("quote (no signature)", () => {
  it("returns fee = gas × base fee × 1.0x paymaster rate, rounded up, and feeTo = the relayer", async () => {
    const q = await quoteGaslessWithdraw({ signer: user.address }, { needsPermit: false, baseFee: BASE, rate: withdrawUsdgPerEth(), feeTo: feeTo() });
    expect(q.feeTo.toLowerCase()).toBe(feeTo().toLowerCase());
    expect(q.spender.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    expect(BigInt(q.fee)).toBe(feeNow(false));
    expect(BigInt(q.minAmount)).toBe(feeNow(false) + 1n);
  });
});

describe("admission + exact simulation", () => {
  it("happy path: one Multicall3 relayer tx, budget after gates, gas cap is the withdraw limit", async () => {
    const order: string[] = [];
    h.call.mockImplementation(async () => { order.push("sim"); return { data: "0x" }; });
    h.budget.mockImplementation(async () => { order.push("budget"); return 0; });
    let raw: Hex | undefined;
    h.send.mockImplementation(async (r: Hex) => { order.push("send"); raw = r; return okRc(); });
    const r = await relay(await wire());
    expect(r).toMatchObject({ kind: "confirmed", success: true });
    expect(order).toEqual(["sim", "budget", "send"]);
    const simArgs = h.call.mock.calls[0][0] as { to: string; data: Hex };
    expect(simArgs.to.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    expect(decodeFunctionData({ abi: multicall3Abi, data: simArgs.data }).functionName).toBe("aggregate3");
    expect(parseTransaction(raw!).to?.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    expect(parseTransaction(raw!).gas).toBe(WITHDRAW_TX_GAS_LIMIT);
  });
  it("revoked or in the strike window ⇒ notSent", async () => {
    h.mget.mockImplementation(async (ks: string[]) => ks.map(k => k.startsWith("relay:trust:") ? JSON.stringify({ strikeUntil: Date.now() + 60_000 }) : null));
    await expect(relay(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("banned (wallet or DID) ⇒ notSent", async () => {
    h.mget.mockImplementation(async (ks: string[]) => ks.map(k => k === `relay:banned:${user.address.toLowerCase()}` ? "1" : null));
    await expect(relay(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("banned") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("missing identity token ⇒ notSent before simulation", async () => {
    await expect(relay(await wire(), { idToken: null })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("no Privy identity token") });
    expect(h.call).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it("session wallet mismatch ⇒ notSent", async () => {
    await expect(relay(await wire(), { idToken: session([other.address]).token })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("not this Privy session's wallet") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("amount <= fee refused before send", async () => {
    const fee = feeNow();
    await expect(relay(await wire({ amount: fee, fee }))).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("amount must exceed the network fee") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("signature by another key ⇒ refused before send", async () => {
    const w = await wire();
    const deadline = BigInt(NOW + 120), fee = feeNow();
    const netPermit = { permitted: { token: usdg, amount: BigInt(w.amount) - fee }, nonce: 0n, deadline };
    w.netSignature = await other.signTypedData(transferTypedData(46630, netPermit));
    await expect(relay(w)).rejects.toThrow("signature is not the signer's");
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("included revert strike policy (trader-caused only)", () => {
  it("a relayer-side included revert (unknown / slippage) does not strike; the next withdraw is admitted", async () => {
    h.call.mockImplementation(async () => {
      if (h.call.mock.calls.length <= 1) return { data: "0x" };
      throw Object.assign(new Error("execution reverted: Slippage()"), { walk: (f: (x: unknown) => boolean) => f({ data: errSel("Slippage()") }) });
    });
    h.send.mockResolvedValue(okRc("0x0"));
    const r = await relay(await wire());
    expect(r.success).toBe(false);
    h.call.mockResolvedValue({ data: "0x" });
    h.send.mockResolvedValue(okRc());
    await expect(relay(await wire())).resolves.toMatchObject({ success: true });
  });
});

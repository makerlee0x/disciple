/** flow/gasless-claims relay: same Privy/revoke/strike gate, Multicall3 submit, no-strike on relayer-side failure. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, parseTransaction, slice, toBytes, type Address, type Hex } from "viem";
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
import { quoteGaslessAction, relayGaslessAction, actionFeeTo, actionUsdgPerEth } from "../lib/server/gaslessActionRelay";
import { gaslessSessionDeps } from "../lib/server/gaslessSession";
import { strikeSource } from "../lib/server/relayLockdown";
import { ACTION_TX_GAS_LIMIT, actionGas, transferTypedData, withdrawFeeRaw } from "../lib/trade/gaslessAction";
import { trampWallManagerAbi, anonLauncherAbi } from "../lib/abi";
import { DEPLOYMENTS } from "../lib/chains";
import type { GaslessDeps } from "../lib/server/gaslessRelay";

const user = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const APP = "testapp0001";
const { privateKey: PRIVY_SK, publicKey: PRIVY_PK } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64u = (x: Buffer | string) => Buffer.from(x).toString("base64url");
let didSeq = 0;
function jwt(sub: string, o: { exp?: number; aud?: string; accounts?: string } = {}) {
  const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: "privy.io", aud: o.aud ?? APP, sub, sid: "s1", iat: NOW - 10, exp: o.exp ?? NOW + 3600, linked_accounts: o.accounts ?? "[]" }));
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), { key: PRIVY_SK, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}
function session(wallets: string[], logins: string[] = ["email"]) {
  const did = `did:privy:tester${String(++didSeq).padStart(6, "0")}`;
  const accounts = JSON.stringify([
    ...logins.map(type => type === "google_oauth" ? { type, email: "a@b.co" } : { type, address: "a@b.co" }),
    ...wallets.map(address => ({ type: "wallet", chain_type: "ethereum", address, wallet_client_type: "privy" })),
  ]);
  return { did, token: jwt(did, { accounts }) };
}
const privyFetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
let TOKEN = "";
const relay = (b: unknown, d: GaslessDeps = {}) => relayGaslessAction(b, { idToken: TOKEN, ...d });
const NOW = Math.floor(Date.now() / 1000);
const BASE = 11_100_000n;
const errSel = (sig: string) => slice(keccak256(toBytes(sig)), 0, 4);
const okRc = (status = "0x1") => ({ rc: { transactionHash: `0x${"ab".repeat(32)}` as Hex, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", status, gasUsed: "0x30d40", effectiveGasPrice: "0x1312d00", logs: [] }, via: "sync", sendMs: 5, minedMs: 0, pending: false });
const usdg = DEPLOYMENTS[46630].usdg;
function feeNow(kind: "anonClaim" = "anonClaim") {
  return withdrawFeeRaw(actionGas(kind, 1, false), BASE, actionUsdgPerEth(), DEPLOYMENTS[46630].usdgDecimals);
}
function claimCall() {
  return { to: "0x00000000000000000000000000000000000000aa", data: encodeFunctionData({
    abi: anonLauncherAbi, functionName: "claimManyBySig",
    args: [{ owner: user.address, tokens: [usdg], to: user.address, relayerFeeBps: 0n, deadline: BigInt(NOW + 120), sig: "0x11" as Hex }],
  }) };
}
async function wireClaim(o: { signer?: typeof user; fee?: bigint } = {}) {
  const s = o.signer ?? user, fee = o.fee ?? feeNow(), deadline = BigInt(NOW + 120);
  const feePermit = { permitted: { token: usdg, amount: fee }, nonce: 0n, deadline };
  return JSON.parse(JSON.stringify({
    kind: "anonClaim", signer: s.address, calls: [claimCall()], fee, feeTo: actionFeeTo(),
    feePermit, feeSignature: await s.signTypedData(transferTypedData(46630, feePermit)),
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
function wirePull() {
  return { kind: "trampPull", signer: user.address, calls: [{ to: DEPLOYMENTS[46630].trampWallManager, data: encodeFunctionData({ abi: trampWallManagerAbi, functionName: "pull", args: [1n] }) }], fee: "0", feeTo: actionFeeTo() };
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
  it("anonClaim fee is gas × base fee × 1.0x, trampPull fee is 0 and reports keeperTipBps", async () => {
    const q = await quoteGaslessAction({ kind: "anonClaim", signer: user.address }, { baseFee: BASE, needsPermit: false });
    expect(BigInt(q.fee)).toBe(feeNow());
    expect(q.feeTo).toBe(actionFeeTo());
    h.read.mockResolvedValueOnce(10); // keeperTipBps
    const p = await quoteGaslessAction({ kind: "trampPull" }, { baseFee: BASE });
    expect(p.fee).toBe("0");
    expect(p.keeperTipBps).toBe(10);
  });
});

describe("admission + exact simulation", () => {
  it("happy path claim: one Multicall3 tx, budget after gates, gas cap is the action limit", async () => {
    const r = await relay(await wireClaim());
    expect(r.success).toBe(true);
    expect(h.budget).toHaveBeenCalled();
    const raw = h.send.mock.calls[0][0] as Hex;
    const tx = parseTransaction(raw);
    expect(tx.to?.toLowerCase()).toBe("0xcA11bde05977b3631167028862bE2a173976CA11".toLowerCase());
    expect(tx.gas).toBe(ACTION_TX_GAS_LIMIT.anonClaim);
  });
  it("trampPull with fee 0 needs no Permit2 signature and still passes the gate", async () => {
    const r = await relay(wirePull());
    expect(r.success).toBe(true);
  });
  it("revoked or in the strike window ⇒ notSent", async () => {
    h.mget.mockResolvedValue(["1", null, null, null, null, null]); // ban/revoke/trust for wallet
    await expect(relay(await wireClaim())).rejects.toMatchObject({ notSent: true });
    h.mget.mockImplementation(async (ks: string[]) => ks.map(() => null));
    strikeSource.local = () => Date.now() + 60_000;
    await expect(relay(await wireClaim())).rejects.toMatchObject({ notSent: true });
  });
  it("missing identity token ⇒ notSent before simulation", async () => {
    await expect(relay(await wireClaim(), { idToken: null })).rejects.toMatchObject({ notSent: true });
  });
  it("signature by another key ⇒ refused before send", async () => {
    const body = await wireClaim();
    body.feeSignature = await other.signTypedData(transferTypedData(46630, { permitted: { token: usdg, amount: BigInt(body.fee) }, nonce: 0n, deadline: BigInt(NOW + 120) }));
    await expect(relay(body)).rejects.toMatchObject({ notSent: true });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("a relayer-side included revert (unknown / slippage) does not strike; the next action is admitted", async () => {
    h.call.mockImplementation(async () => {
      if (h.call.mock.calls.length <= 1) return { data: "0x" };
      throw Object.assign(new Error("execution reverted: Slippage()"), { walk: (f: (x: unknown) => boolean) => f({ data: errSel("Slippage()") }) });
    });
    h.send.mockResolvedValue(okRc("0x0"));
    const r = await relay(await wireClaim());
    expect(r.success).toBe(false);
    h.call.mockResolvedValue({ data: "0x" });
    h.send.mockResolvedValue(okRc());
    await expect(relay(await wireClaim())).resolves.toMatchObject({ success: true });
  });
});

/** Gasless withdraw relay with DisciplePermitForwarder deployed: one witness signature, forwarder target, the old shape refused. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseTransaction, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  process.env.NEXT_PUBLIC_RHT_GASLESS_ROUTER = "0x00000000000000000000000000000000000000bb";
  process.env.NEXT_PUBLIC_RHT_PERMIT_FORWARDER = "0x00000000000000000000000000000000000000f0";
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
import { relayGaslessWithdraw, relayMarketBuy, quoteGaslessWithdraw, withdrawFeeTo, withdrawUsdgPerEth } from "../lib/server/gaslessWithdrawRelay";
import { gaslessSessionDeps } from "../lib/server/gaslessSession";
import { strikeSource } from "../lib/server/relayLockdown";
import { MULTICALL3, multicall3Abi, transferTypedData, withdrawFeeRaw, withdrawGas, WITHDRAW_TX_GAS_LIMIT } from "../lib/trade/gaslessWithdraw";
import { forwarderAbi, withdrawTypedData } from "../lib/trade/permitForwarder";
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
const okRc = (status = "0x1") => ({ rc: { transactionHash: `0x${"ab".repeat(32)}` as Hex, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", status, gasUsed: "0x30d40", effectiveGasPrice: "0x1312d00", logs: [] }, via: "sync", sendMs: 5, minedMs: 0, pending: false });
const feeTo = () => withdrawFeeTo();
function feeNow(needsPermit = false) {
  return withdrawFeeRaw(withdrawGas(needsPermit), BASE, withdrawUsdgPerEth(), DEPLOYMENTS[46630].usdgDecimals);
}
const FWD = "0x00000000000000000000000000000000000000f0" as Address;
async function wireFwd(o: { signer?: typeof user; amount?: bigint; fee?: bigint; dest?: Address; signedDest?: Address } = {}) {
  const s = o.signer ?? user, fee = o.fee ?? feeNow(), amount = o.amount ?? fee + 1_000_000n, deadline = BigInt(NOW + 120);
  const permit = { permitted: { token: usdg, amount }, nonce: 7n, deadline };
  const signature = await s.signTypedData(withdrawTypedData(46630, FWD, permit, { to: o.signedDest ?? o.dest ?? dest, fee, feeTo: feeTo() }));
  return JSON.parse(JSON.stringify({ signer: s.address, destination: o.dest ?? dest, amount, fee, feeTo: feeTo(), permit, signature },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
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


describe("forwarder deployed", () => {
  it("quote names the forwarder as spender", async () => {
    const q = await quoteGaslessWithdraw({ signer: user.address }, { needsPermit: false, baseFee: BASE, rate: withdrawUsdgPerEth(), feeTo: feeTo() });
    expect(q.spender.toLowerCase()).toBe(FWD);
  });
  it("one witness signature → DisciplePermitForwarder.withdraw with the signed destination, fee and fee recipient", async () => {
    let raw: Hex | undefined;
    h.send.mockImplementation(async (r: Hex) => { raw = r; return okRc(); });
    const r = await relay(await wireFwd());
    expect(r).toMatchObject({ kind: "confirmed", success: true });
    const sim = h.call.mock.calls[0][0] as { to: string; data: Hex };
    expect(sim.to.toLowerCase()).toBe(FWD);
    const dec = decodeFunctionData({ abi: forwarderAbi, data: sim.data });
    expect(dec.functionName).toBe("withdraw");
    const w = dec.args[1] as { to: Address; fee: bigint; feeTo: Address };
    expect(w.to.toLowerCase()).toBe(dest);
    expect(w.fee).toBe(feeNow());
    expect(w.feeTo.toLowerCase()).toBe(feeTo().toLowerCase());
    expect(parseTransaction(raw!).to?.toLowerCase()).toBe(FWD);
    // simulated at the tx's own gas limit, so a call that needs more fails here (unsent) instead of on chain
    expect((sim as { gas?: bigint }).gas).toBe(WITHDRAW_TX_GAS_LIMIT);
  });
  it("a destination other than the signed one is refused before send", async () => {
    await expect(relay(await wireFwd({ dest: "0x00000000000000000000000000000000000000ee", signedDest: dest }))).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("signature is not the signer's") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("the old two-permit Multicall3 shape is refused once the forwarder is live", async () => {
    await expect(relay(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("update the app") });
    expect(h.call).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it("permit amount must be exactly net + fee", async () => {
    const w = await wireFwd();
    w.amount = (BigInt(w.amount) + 1n).toString();
    await expect(relay(w)).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("permit amount mismatch") });
  });
});


describe("market buy: seller + treasury in one tx", () => {
  const TREASURY = "0x00000000000000000000000000000000000007e5" as Address;
  const seller = "0x00000000000000000000000000000000000000aa" as Address;
  const buyFee = () => withdrawFeeRaw(withdrawGas(false) + withdrawGas(false), BASE, withdrawUsdgPerEth(), DEPLOYMENTS[46630].usdgDecimals);
  const j = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  async function one(to: Address, amount: bigint, fee: bigint, nonce: bigint, s = user) {
    const permit = { permitted: { token: usdg, amount }, nonce, deadline: BigInt(NOW + 120) };
    const signature = await s.signTypedData(withdrawTypedData(46630, FWD, permit, { to, fee, feeTo: feeTo() }));
    return { signer: s.address, destination: to, amount, fee, feeTo: feeTo(), permit, signature };
  }
  const pair = async (o: { cutTo?: Address; cutFee?: bigint; cutNonce?: bigint; cutSigner?: typeof user } = {}) => j({
    pay: await one(seller, 9_300_000n + buyFee(), buyFee(), 1n),
    cut: await one(o.cutTo ?? TREASURY, 700_000n, o.cutFee ?? 0n, o.cutNonce ?? 2n, o.cutSigner),
  });
  beforeEach(() => { process.env.MARKET_TREASURY_ADDRESS = TREASURY; });
  afterEach(() => { delete process.env.MARKET_TREASURY_ADDRESS; });

  it("quote covers both withdraws", async () => {
    const q = await quoteGaslessWithdraw({ signer: user.address }, { needsPermit: false, baseFee: BASE, rate: withdrawUsdgPerEth(), feeTo: feeTo(), extraWithdraws: 1 });
    expect(BigInt(q.fee)).toBe(buyFee());
  });
  it("sends one Multicall3 tx with two forwarder withdraws: seller (fee to relayer) and treasury (no fee)", async () => {
    let raw: Hex | undefined;
    h.send.mockImplementation(async (r: Hex) => { raw = r; return okRc(); });
    const r = await relayMarketBuy(await pair(), { idToken: TOKEN });
    expect(r).toMatchObject({ kind: "confirmed", success: true });
    const tx = parseTransaction(raw!);
    expect(tx.to?.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    const agg = decodeFunctionData({ abi: multicall3Abi, data: tx.data! });
    const calls = agg.args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.target.toLowerCase() === FWD && !c.allowFailure)).toBe(true);
    const [a, b] = calls.map((c) => decodeFunctionData({ abi: forwarderAbi, data: c.callData }).args[1] as { to: Address; fee: bigint; feeTo: Address });
    expect(a.to.toLowerCase()).toBe(seller); expect(a.fee).toBe(buyFee()); expect(a.feeTo.toLowerCase()).toBe(feeTo().toLowerCase());
    expect(b.to.toLowerCase()).toBe(TREASURY); expect(b.fee).toBe(0n);
    expect(tx.gas).toBe(WITHDRAW_TX_GAS_LIMIT * 2n);
  });
  it("refuses a cut that isn't to the treasury, carries a fee, reuses the nonce or comes from another wallet", async () => {
    for (const o of [{ cutTo: seller }, { cutFee: 1n }, { cutNonce: 1n }, { cutSigner: other }])
      await expect(relayMarketBuy(await pair(o), { idToken: TOKEN })).rejects.toMatchObject({ notSent: true });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("is off without a treasury address", async () => {
    delete process.env.MARKET_TREASURY_ADDRESS;
    await expect(relayMarketBuy(await pair(), { idToken: TOKEN })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("switched off") });
  });
});

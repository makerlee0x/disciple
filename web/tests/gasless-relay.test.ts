/** flow/gasless-permit2 relay: the switch, admission (LoginGate, revoke/strike, IP), exact simulation before signing,
 *  budget after simulation, replay refusal, strike + breaker on an included revert. RPC / KV / send are mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  process.env.NEXT_PUBLIC_RHT_GASLESS_ROUTER = "0x00000000000000000000000000000000000000bb";
  return { chain: vi.fn(), block: vi.fn(), read: vi.fn(), call: vi.fn(), count: vi.fn(), balance: vi.fn(), incr: vi.fn(), mget: vi.fn(), budget: vi.fn(), refund: vi.fn(), send: vi.fn(), setNX: vi.fn(), get: vi.fn(), incrBy: vi.fn() };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ getChainId: h.chain, getBlock: h.block, readContract: h.read, call: h.call, getTransactionCount: h.count, getBalance: h.balance }) }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({ incrEx: h.incr, mget: h.mget, relayBudget: h.budget, decrIfPositive: h.refund, setNX: h.setNX, get: h.get, incrByEx: h.incrBy, ttl: async () => -2 }) }));
vi.mock("../lib/server/relayer", () => ({ relayerKey: () => KEY, relayerIsFaucet: () => false }));
vi.mock("../lib/server/relayTrustStore", () => ({ kvTrustStore: () => ({ load: async () => null, save: async () => undefined, claimFirstPrime: async () => false }) }));
vi.mock("../lib/server/syncSend", async original => ({ ...await original<typeof import("../lib/server/syncSend")>(), syncSend: h.send, jsonRpc: () => async () => null }));
const KEY = generatePrivateKey();
process.env.RELAYER_NONCE_SHARED = "0";
import { relayGaslessLogin, relayGaslessTrade, requireGaslessMode } from "../lib/server/gaslessRelay";
import { requireSelfBundlerMode } from "../lib/server/relayLockdown";
import { relayBreaker } from "../lib/server/relayBreaker";
import { gaslessRouterAbi, tradeTypedData } from "../lib/trade/gaslessPermit2";
import { DEPLOYMENTS } from "../lib/chains";

const user = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const router = DEPLOYMENTS[46630].gaslessRouter, usdg = DEPLOYMENTS[46630].usdg;
const coin = "0x00000000000000000000000000000000000000c0" as Address;
const NOW = Math.floor(Date.now() / 1000);
const okRc = (status = "0x1") => ({ rc: { transactionHash: `0x${"ab".repeat(32)}` as Hex, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", status, gasUsed: "0x30d40", effectiveGasPrice: "0x1312d00", logs: [] }, via: "sync", sendMs: 5, minedMs: 0, pending: false });
async function wire(o: { signer?: typeof user; recipient?: Address; amountIn?: bigint; isBuy?: boolean } = {}) {
  const s = o.signer ?? user, isBuy = o.isBuy ?? true, amountIn = o.amountIn ?? 3_000_000n, deadline = BigInt(NOW + 120);
  const trade = { coin, isBuy, amountIn, minOut: 1n, recipient: o.recipient ?? s.address, deadline };
  const permit = { permitted: { token: isBuy ? usdg : coin, amount: amountIn }, nonce: 7n, deadline };
  const signature = await s.signTypedData(tradeTypedData(46630, router, permit, trade));
  return JSON.parse(JSON.stringify({ signer: o.signer && o.recipient === undefined ? s.address : user.address, permit, trade, signature }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
beforeEach(() => {
  vi.resetAllMocks(); delete process.env.VERCEL_ENV; delete process.env.VERCEL; process.env.GAS_SPONSORSHIP_MODE = "gasless";
  h.chain.mockResolvedValue(46630); h.block.mockResolvedValue({ timestamp: BigInt(NOW), baseFeePerGas: 10_000_000n });
  h.read.mockImplementation(async ({ functionName }) => functionName === "verifiedUntil" ? BigInt(NOW + 3600) : 0n);
  h.call.mockResolvedValue({ data: "0x" }); h.count.mockResolvedValue(5); h.balance.mockResolvedValue(0n);
  h.incr.mockResolvedValue(1); h.mget.mockImplementation(async (ks: string[]) => ks.map(() => null)); h.budget.mockResolvedValue(0); h.refund.mockResolvedValue(0);
  h.send.mockResolvedValue(okRc()); h.setNX.mockResolvedValue(true); h.get.mockResolvedValue(null); h.incrBy.mockResolvedValue(1);
});
afterEach(() => vi.unstubAllEnvs());

describe("switch: GAS_SPONSORSHIP_MODE", () => {
  it("off (default self) ⇒ gasless refused notSent, nothing read or sent; the old self-bundler stays selectable", async () => {
    process.env.GAS_SPONSORSHIP_MODE = "self";
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("gasless relay disabled") });
    expect(h.call).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    expect(() => requireSelfBundlerMode()).not.toThrow();
  });
  it("on ⇒ gasless admitted; the old self-bundler is refused (one transport at a time)", () => {
    expect(() => requireGaslessMode()).not.toThrow();
    expect(() => requireSelfBundlerMode()).toThrow("self-bundler disabled");
  });
  it("never in Production", async () => {
    vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("VERCEL", "1");
    expect(() => requireGaslessMode()).toThrow("disabled");
  });
});

describe("admission + exact simulation", () => {
  it("happy path: LoginGate ∥ gate ∥ sim, budget AFTER sim, one relayer tx to the gasless router with the signed call", async () => {
    const order: string[] = [];
    h.call.mockImplementation(async () => { order.push("sim"); return { data: "0x" }; });
    h.budget.mockImplementation(async () => { order.push("budget"); return 0; });
    h.send.mockImplementation(async () => { order.push("send"); return okRc(); });
    const r = await relayGaslessTrade(await wire());
    expect(r).toMatchObject({ kind: "confirmed", success: true, gasUsed: 200_000 });
    expect(order).toEqual(["sim", "budget", "send"]);
    const simArgs = h.call.mock.calls[0][0] as { to: string; data: Hex };
    expect(simArgs.to.toLowerCase()).toBe(router.toLowerCase());
    const d = decodeFunctionData({ abi: gaslessRouterAbi, data: simArgs.data });
    expect(d.functionName).toBe("buyWithPermit2"); expect((d.args[0] as string).toLowerCase()).toBe(user.address.toLowerCase());
    expect(h.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: "verifiedUntil", args: [user.address] }));
  });
  it("not logged in on LoginGate ⇒ notSent, no budget, no send", async () => {
    h.read.mockResolvedValue(0n);
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("unauthenticated") });
    expect(h.budget).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it("revoked or in the strike window ⇒ notSent", async () => {
    h.mget.mockImplementation(async (ks: string[]) => ks.map(k => k.startsWith("relay:trust:") ? JSON.stringify({ strikeUntil: Date.now() + 60_000 }) : null));
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("IP limit gate (from the route) is part of admission", async () => {
    const ipGate = Promise.reject(Object.assign(new Error("rate limited"), { limited: true })); void ipGate.catch(() => undefined);
    await expect(relayGaslessTrade(await wire(), { ipGate })).rejects.toMatchObject({ notSent: true });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("signature by another key / recipient ≠ signer / below $3 ⇒ refused before ANY RPC", async () => {
    await expect(relayGaslessTrade(await wire({ signer: other, recipient: user.address }))).rejects.toThrow("signature is not the signer's");
    await expect(relayGaslessTrade(await wire({ recipient: other.address }))).rejects.toThrow("recipient must be the signer");
    await expect(relayGaslessTrade(await wire({ amountIn: 2_000_000n }))).rejects.toThrow("minimum trade is $3");
    expect(h.read).not.toHaveBeenCalled(); expect(h.call).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it("replay (Permit2 InvalidNonce in the exact simulation) ⇒ notSent, no budget, no send", async () => {
    h.call.mockRejectedValue(Object.assign(new Error("execution reverted: InvalidNonce()"), { walk: () => undefined }));
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("simulation failed") });
    expect(h.budget).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it("per-sender / global quota hit after a passing sim ⇒ notSent, nothing signed", async () => {
    h.budget.mockResolvedValue(1);
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("rate limited") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("definite send rejection before acceptance ⇒ global unit refunded", async () => {
    h.send.mockRejectedValue(Object.assign(new Error("insufficient funds for gas"), { code: -32000, definitive: true }));
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true });
    expect(h.refund).toHaveBeenCalled();
  });
});

describe("login relay (LoginGate.attest for a no-ETH EOA)", () => {
  it("bad attestation shape refused before RPC; per-wallet limit applies", async () => {
      await expect(relayGaslessLogin({ wallet: user.address, expiry: NOW + 999_999_999, signature: `0x${"11".repeat(65)}` })).rejects.toThrow("bad expiry");
      h.incr.mockResolvedValue(4);
      await expect(relayGaslessLogin({ wallet: user.address, expiry: NOW + 7200, signature: `0x${"11".repeat(65)}` })).rejects.toMatchObject({ notSent: true });
      expect(h.send).not.toHaveBeenCalled();
  });
});

describe("loss breaker (runs last: it stays open for this module)", () => {
  it("included revert ⇒ strike + loss breaker record; 2 reverts open the breaker ⇒ next request refused notSent", async () => {
    h.send.mockResolvedValue(okRc("0x0"));
    const r = await relayGaslessTrade(await wire()); expect(r.success).toBe(false);
    h.incr.mockResolvedValue(2);   // window revert count
    await relayGaslessTrade(await wire({ signer: other, isBuy: false, amountIn: 5n })).catch(() => undefined);   // another sender (the first is struck)
    expect(h.setNX).toHaveBeenCalledWith("relay:breaker:open", expect.any(String), expect.any(Number));
    expect(relayBreaker.isOpen()).toBe(true);
    const third = privateKeyToAccount(generatePrivateKey());
    await expect(relayGaslessTrade(await wire({ signer: third }))).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("relay paused") });
  });
});

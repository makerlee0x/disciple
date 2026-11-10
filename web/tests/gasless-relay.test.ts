/** flow/gasless-permit2 relay: the switch, admission (off-chain Privy session, revoke/strike, IP), exact simulation before signing,
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
import { relayGaslessLogin, relayGaslessTrade as relayTrade, requireGaslessMode, LEGACY_LOGIN_MESSAGE, LEGACY_PVE_CODE, NOT_VERIFIED_SELECTOR, assertGaslessMarket, gaslessMarketCache, type GaslessDeps } from "../lib/server/gaslessRelay";
import { gaslessSessionDeps } from "../lib/server/gaslessSession";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { requireSelfBundlerMode } from "../lib/server/relayLockdown";
import { relayBreaker } from "../lib/server/relayBreaker";
import { gaslessRouterAbi, tradeTypedData } from "../lib/trade/gaslessPermit2";
import { DEPLOYMENTS } from "../lib/chains";

const user = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
// Off-chain login: a test ES256 key stands in for the Privy app key; the Privy users API is a fake fetch.
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
/** A fresh Privy identity token (linked_accounts in the JWT) owning `wallets`. */
function session(wallets: string[], logins: string[] = ["email"], o: Parameters<typeof jwt>[1] = {}) {
  const did = `did:privy:tester${String(++didSeq).padStart(6, "0")}`;
  const accounts = JSON.stringify([
    ...logins.map(type => type === "google_oauth" ? { type, email: "a@b.co" } : { type, address: "a@b.co" }),
    ...wallets.map(address => ({ type: "wallet", chain_type: "ethereum", address, wallet_client_type: "privy" })),
  ]);
  return { did, token: jwt(did, { ...o, accounts }) };
}
const privyFetch = vi.fn(async (url: string) => {
  const did = decodeURIComponent(url.split("/users/")[1] ?? "");
  const u = users.get(did);
  return { ok: !!u, status: u ? 200 : 404, json: async () => u };
});
let TOKEN = "";
const relayGaslessTrade = (b: unknown, d: GaslessDeps = {}) => relayTrade(b, { idToken: TOKEN, ...d });
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
  privyFetch.mockClear();
  gaslessSessionDeps.env = () => ({ appId: APP, appSecret: "test-secret", verificationKey: PRIVY_PK.export({ type: "spki", format: "pem" }).toString() });
  gaslessSessionDeps.fetch = privyFetch as never;
  gaslessSessionDeps.invite = async () => ({ ok: true });
  gaslessMarketCache.clear();
  TOKEN = session([user.address, other.address]).token;
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
  it("happy path: Privy session ∥ gate ∥ sim (parallel), budget AFTER all gates, one relayer tx to the gasless router with the signed call", async () => {
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
    // No on-chain login record: LoginGate is never read on this path.
    expect(h.read).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "verifiedUntil" }));
  });
  it("no LoginGate attestation (verifiedUntil = 0) but a valid Privy session ⇒ admitted", async () => {
    h.read.mockResolvedValue(0n);
    await expect(relayGaslessTrade(await wire())).resolves.toMatchObject({ success: true });
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

describe("off-chain login (Privy identity token) — rejected before simulation, budget and send", () => {
  const none = () => { expect(h.call).not.toHaveBeenCalled(); expect(h.budget).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); };
  it("valid identity token whose linked wallet == signer ⇒ passes, and the users API is not called", async () => {
    await expect(relayGaslessTrade(await wire())).resolves.toMatchObject({ success: true });
    expect(privyFetch).not.toHaveBeenCalled();
  });
  it("valid session for ANOTHER wallet (signer not linked) ⇒ notSent 'not this Privy session's wallet', nothing budgeted/sent", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    await expect(relayGaslessTrade(await wire(), { idToken: session([stranger.address]).token })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("not this Privy session's wallet") });
    expect(h.budget).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it("missing identity token ⇒ notSent before simulation", async () => {
    await expect(relayGaslessTrade(await wire(), { idToken: null })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("no Privy identity token") });
    none(); expect(privyFetch).not.toHaveBeenCalled();
  });
  it("expired identity token ⇒ notSent before simulation", async () => {
    await expect(relayGaslessTrade(await wire(), { idToken: session([user.address], ["email"], { exp: NOW - 3600 }).token })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("expired") });
    none();
  });
  it("forged token (wrong key) / wrong audience / garbage ⇒ notSent before simulation", async () => {
    const { privateKey: evil } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    for (const t of [session([user.address], ["email"], { key: evil }).token, session([user.address], ["email"], { aud: "otherapp001" }).token, "a.b.c"])
      await expect(relayGaslessTrade(await wire(), { idToken: t })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("invalid or expired") });
    none();
  });
  it("wallet-only Privy user (no verified email / Google / X login) ⇒ notSent", async () => {
    await expect(relayGaslessTrade(await wire(), { idToken: session([user.address], ["wallet"]).token })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("login not verified") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("invite gate refusal ⇒ notSent", async () => {
    gaslessSessionDeps.invite = async () => ({ ok: false });
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("invite") });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("Privy not configured ⇒ fail closed", async () => {
    gaslessSessionDeps.env = () => ({ appId: "" });
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("isn't configured") });
    none();
  });
});

describe("speculative parallel simulation (sim ∥ revoke/strike/blocklist read)", () => {
  /** Delay only the revoke/strike MGET (not leasegen / other mgets). `release` lets a succeeding sim finish first. */
  const holdGate = (result: (ks: string[]) => (string | null)[]) => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    h.mget.mockImplementation(async (ks: string[]) => {
      if (ks.some(k => k.startsWith("relay:revoked:") || k.startsWith("relay:trust:") || k.startsWith("relay:banned:"))) await held;
      return result(ks);
    });
    return { release: () => release(), held };
  };
  const noChargeOrSend = () => { expect(h.budget).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); };

  it("revoked player is refused and no budget/send happens, even when simulation resolves first and succeeds", async () => {
    const order: string[] = [];
    const { release } = holdGate(ks => ks.map(k => k.startsWith("relay:revoked:") ? "revoked" : null));
    h.call.mockImplementation(async () => { order.push("sim"); queueMicrotask(release); return { data: "0x" }; });
    h.budget.mockImplementation(async () => { order.push("budget"); return 0; });
    h.send.mockImplementation(async () => { order.push("send"); return okRc(); });
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("revoked") });
    expect(order[0]).toBe("sim"); expect(order).not.toContain("budget"); expect(order).not.toContain("send");
    expect(h.call).toHaveBeenCalled(); noChargeOrSend();
  });
  it("struck / blocklisted player is refused and no budget/send happens, even when simulation resolves first and succeeds", async () => {
    const order: string[] = [];
    const { release } = holdGate(ks => ks.map(k => k.startsWith("relay:trust:") ? JSON.stringify({ strikeUntil: Date.now() + 60_000 }) : null));
    h.call.mockImplementation(async () => { order.push("sim"); queueMicrotask(release); return { data: "0x" }; });
    h.budget.mockImplementation(async () => { order.push("budget"); return 0; });
    h.send.mockImplementation(async () => { order.push("send"); return okRc(); });
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike") });
    expect(order[0]).toBe("sim"); expect(order).not.toContain("budget"); expect(order).not.toContain("send");
    expect(h.call).toHaveBeenCalled(); noChargeOrSend();
  });
  it("unreadable strike ledger entry ⇒ fail closed, no budget/send (simulation result discarded)", async () => {
    const { release } = holdGate(ks => ks.map(k => k.startsWith("relay:trust:") ? "{not json" : null));
    h.call.mockImplementation(async () => { queueMicrotask(release); return { data: "0x" }; });
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike") });
    noChargeOrSend();
  });
  it("happy path still sends (sim ∥ gate, budget after both pass)", async () => {
    const order: string[] = [];
    h.call.mockImplementation(async () => { order.push("sim"); return { data: "0x" }; });
    h.budget.mockImplementation(async () => { order.push("budget"); return 0; });
    h.send.mockImplementation(async () => { order.push("send"); return okRc(); });
    await expect(relayGaslessTrade(await wire())).resolves.toMatchObject({ kind: "confirmed", success: true });
    expect(order).toEqual(["sim", "budget", "send"]);
  });
  it("revoke/strike store error ⇒ fail closed (no charge or send), even when simulation resolves first and succeeds", async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    h.mget.mockImplementation(async (ks: string[]) => {
      if (ks.some(k => k.startsWith("relay:revoked:") || k.startsWith("relay:trust:") || k.startsWith("relay:banned:"))) { await held; throw new Error("kv down"); }
      return ks.map(() => null);
    });
    h.call.mockImplementation(async () => { order.push("sim"); queueMicrotask(release); return { data: "0x" }; });
    h.budget.mockImplementation(async () => { order.push("budget"); return 0; });
    h.send.mockImplementation(async () => { order.push("send"); return okRc(); });
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("gate store unavailable") });
    expect(order[0]).toBe("sim"); expect(order).not.toContain("budget"); expect(order).not.toContain("send");
    noChargeOrSend();
  });
});

describe("H1/M1/M2/M3: permanent ban, DID keys, identity token, legacy Easy curves", () => {
  const noChargeOrSend = () => { expect(h.budget).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); };
  it("ban persists past 600 s (permanent key, no expiry) — refused, no budget/send", async () => {
    const at = Date.now() - 700_000;   // older than the 600 s marker TTL
    h.mget.mockImplementation(async (ks: string[]) => ks.map(k => k === `relay:banned:${user.address.toLowerCase()}` ? String(at) : null));
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("banned") });
    noChargeOrSend();
  });
  it("ban by DID blocks a new linked wallet — refused, no budget/send", async () => {
    const ses = session([user.address, other.address]); TOKEN = ses.token;
    h.mget.mockImplementation(async (ks: string[]) => ks.map(k => k === `relay:banned:${ses.did.toLowerCase()}` ? "1" : null));
    await expect(relayGaslessTrade(await wire({ signer: other }))).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("banned") });
    noChargeOrSend();
  });
  it("strike by DID blocks a new linked wallet — refused, no budget/send", async () => {
    const ses = session([user.address, other.address]); TOKEN = ses.token;
    h.mget.mockImplementation(async (ks: string[]) => ks.map(k => k === `relay:trust:${ses.did.toLowerCase()}` ? JSON.stringify({ strikeUntil: Date.now() + 60_000 }) : null));
    await expect(relayGaslessTrade(await wire({ signer: other }))).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike") });
    noChargeOrSend();
  });
  it("identity token with an unlinked wallet is refused; no users-API call on the trade path", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    await expect(relayGaslessTrade(await wire(), { idToken: session([stranger.address]).token })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("not this Privy session's wallet") });
    expect(privyFetch).not.toHaveBeenCalled();
    noChargeOrSend();
  });
  it("happy path does not call the Privy users API", async () => {
    await expect(relayGaslessTrade(await wire())).resolves.toMatchObject({ success: true });
    expect(privyFetch).not.toHaveBeenCalled();
  });
  it("legacy Easy/PvE curve is refused before simulation with no budget/send", async () => {
    const curve = "0x00000000000000000000000000000000000000c1", gate = DEPLOYMENTS[46630].loginGate;
    h.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "curveOf") return curve;
      if (functionName === "loginGate") return gate;
      if (functionName === "mode") return 1;
      if (functionName === "graduated") return false;
      return 0n;
    });
    gaslessMarketCache.clear();
    await expect(assertGaslessMarket(coin, true)).rejects.toMatchObject({ code: LEGACY_PVE_CODE, message: LEGACY_LOGIN_MESSAGE });
    h.call.mockClear(); h.budget.mockClear(); h.send.mockClear();
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, code: LEGACY_PVE_CODE, message: LEGACY_LOGIN_MESSAGE });
    expect(h.call).not.toHaveBeenCalled(); noChargeOrSend();
  });
});

describe("existing curves (still check LoginGate on-chain)", () => {
  it("existing Easy curve, wallet without a LoginGate attestation ⇒ exact sim reverts NotVerified ⇒ clear notSent, no budget/send", async () => {
    h.call.mockRejectedValue(Object.assign(new Error("execution reverted"), { walk: (f: (x: unknown) => boolean) => f({ data: NOT_VERIFIED_SELECTOR }) }));
    await expect(relayGaslessTrade(await wire())).rejects.toMatchObject({ notSent: true, message: LEGACY_LOGIN_MESSAGE, data: NOT_VERIFIED_SELECTOR });
    expect(h.budget).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it("existing curve + attested wallet (sim passes) ⇒ sent; the Privy session is still required", async () => {
    await expect(relayGaslessTrade(await wire())).resolves.toMatchObject({ success: true });
    await expect(relayGaslessTrade(await wire(), { idToken: null })).rejects.toMatchObject({ notSent: true });
  });
  it("NotVerified selector is BondingCurve's error NotVerified()", () => { expect(NOT_VERIFIED_SELECTOR).toBe("0x83932d18"); });
});

describe("client sends the Privy session", () => {
  it("submitGasless puts the identity token in privy-id-token (and omits it when logged out)", async () => {
    const { submitGasless } = await import("../lib/trade/gaslessClient");
    const seen: (Record<string, string> | undefined)[] = [];
    const f = (async (_u: string, init?: { headers?: Record<string, string> }) => { seen.push(init?.headers); return { status: 200, json: async () => ({ result: { txHash: "0x1", success: true, receipt: { logs: [] }, gasUsed: 1 } }) }; }) as never;
    const q = await wire();
    await submitGasless(q, "/api/gasless", f, "tok.en.x"); await submitGasless(q, "/api/gasless", f, null);
    expect(seen[0]?.["privy-id-token"]).toBe("tok.en.x"); expect(seen[1]?.["privy-id-token"]).toBeUndefined();
  });
});

describe("login relay (LoginGate.attest for a no-ETH EOA) — OFF by default, TODO delete", () => {
  it("off unless GASLESS_LOGIN_RELAY=1 ⇒ refused notSent, nothing read or sent", async () => {
    await expect(relayGaslessLogin({ wallet: user.address, expiry: NOW + 7200, signature: `0x${"11".repeat(65)}` })).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("login relay is off") });
    expect(h.call).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it("bad attestation shape refused before RPC; per-wallet limit applies (when explicitly enabled)", async () => {
      vi.stubEnv("GASLESS_LOGIN_RELAY", "1");
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
    TOKEN = session([other.address]).token;   // a different Privy user — the first signer (and their did) is struck
    await relayGaslessTrade(await wire({ signer: other, isBuy: false, amountIn: 5n })).catch(() => undefined);
    expect(h.setNX).toHaveBeenCalledWith("relay:breaker:open", expect.any(String), expect.any(Number));
    expect(relayBreaker.isOpen()).toBe(true);
    const third = privateKeyToAccount(generatePrivateKey());
    await expect(relayGaslessTrade(await wire({ signer: third }))).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("relay paused") });
  });
});

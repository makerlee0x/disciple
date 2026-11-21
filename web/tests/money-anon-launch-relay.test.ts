/**
 * Money flow: a hidden (anon) launch (lib/server/gaslessAnonLaunchRelay relayAnonFreeLaunch). Who signs: nobody's wallet
 * goes on chain; the relayer sends CreatorFeeHarvest.launchAnon itself. Who pays gas: the relayer up front, then the
 * launch's gas in USDG goes on the account's private tab (lib/server/launchTab), paid a step at a time on later cash-outs.
 * This pins the money rules: the quote is the relayer's estimate +10% x base fee x live USDG/ETH, a launch that would push
 * the tab past its cap is refused before anything is sent, only a landed launch is added to the tab, and the launcher
 * must charge no launch fee. Chain reads, the relayer, sign-in and the launch encoder are stubbed; the tab is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

const LAUNCHER = "0x00000000000000000000000000000000000000a1" as Address;
const HARVEST = "0x00000000000000000000000000000000000000a2" as Address;
const RELAYER = "0x00000000000000000000000000000000000000ee" as Address;
const WALLET = "0x929D22560c48d3240a7e35559810d58f3d2692aD" as Address;

const h = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  launchFee: BigInt(0),
  anonOf: "0x00000000000000000000000000000000000000a1",
  est: BigInt(6_000_000),
  baseFee: BigInt(20_000_000), // 0.02 gwei
  rate: BigInt(3_000) * BigInt(1_000_000), // 3,000 USDG per ETH at 6 decimals
  routing: true,
  sent: [] as { to: string; data: string; gas: bigint }[],
  status: "0x1",
  rejectSession: false,
}));

vi.mock("viem", async (orig) => ({
  ...(await orig<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "launchFee" ? h.launchFee : functionName === "anon" ? h.anonOf : null),
    estimateGas: async () => h.est,
  }),
}));
vi.mock("../lib/server/kv", () => ({
  kv: () => ({
    get: async (k: string) => h.kv.get(k) ?? null,
    incrByEx: async (k: string, by: number) => { const n = Number(h.kv.get(k) ?? 0) + by; h.kv.set(k, String(n)); return n; },
    del: async (...ks: string[]) => { ks.forEach((k) => h.kv.delete(k)); },
  }),
}));
vi.mock("../lib/anon", () => ({ ANON_ADDONS: new Proxy({}, { get: () => ({ anonLauncher: "0x00000000000000000000000000000000000000a1" }) }) }));
vi.mock("../lib/quickLaunch", () => ({ creatorFeeRoutingAvailable: () => h.routing }));
vi.mock("../lib/trade/freeAnonLaunch", () => ({
  parseFreeAnonLaunchRequest: (raw: { wallet: string }) => ({ wallet: raw.wallet, launch: { name: "X" } }),
  checkFreeAnonLaunch: (_q: unknown, o: { harvest: string | null }) => { if (!o.harvest) throw Object.assign(new Error("hidden launches aren't live"), { name: "GaslessReject" }); },
  encodeFreeAnonLaunch: () => "0xfeed",
}));
vi.mock("../lib/chains", async (orig) => {
  const real = await orig<typeof import("../lib/chains")>();
  return { ...real, deployment: () => ({ ...real.deployment(), creatorFeeHarvest: "0x00000000000000000000000000000000000000a2", usdgDecimals: 6 }) };
});
vi.mock("../lib/server/gaslessRelay", () => ({ requireGaslessMode: () => undefined }));
vi.mock("../lib/server/relayBreaker", () => ({ relayBreaker: { assertClosed: () => undefined, record: async () => true }, recordSenderRevert: async () => ({ tooMany: false }) }));
vi.mock("../lib/server/gaslessSession", () => ({
  verifySessionToken: async () => { if (h.rejectSession) throw Object.assign(new Error("sign in again"), { notSent: true }); return { did: "did:privy:1", wallets: [] }; },
  requireSessionWallet: async () => undefined,
}));
vi.mock("../lib/server/relayLockdown", () => ({ requireNotRevokedOrStruck: async () => undefined, relaySendBudget: async () => async () => undefined }));
vi.mock("../lib/server/fastRelay", () => ({
  directRelayer: async () => ({ address: "0x00000000000000000000000000000000000000ee", fee: h.baseFee, st: {} }),
  simulateDirect: async () => undefined,
  sendDirect: async (_r: unknown, to: string, data: string, gas: bigint) => {
    h.sent.push({ to, data, gas });
    return { txHash: "0x" + "ab".repeat(32), rc: { status: h.status, gasUsed: "0x5b8d80", effectiveGasPrice: "0x1312d00" }, via: "sync", sendMs: 1, minedMs: 0 };
  },
  strikeSender: () => undefined,
}));
vi.mock("../lib/server/usdgEthRate", () => ({ liveUsdgPerEth: async () => h.rate }));
vi.mock("../lib/server/gaslessWithdrawRelay", () => ({ withdrawFeeTo: () => "0x00000000000000000000000000000000000000ee" }));

import { quoteAnonFreeLaunch, relayAnonFreeLaunch } from "../lib/server/gaslessAnonLaunchRelay";
import { tabMax, tabOwed } from "../lib/server/launchTab";
import { withdrawFeeRaw } from "../lib/trade/gaslessWithdraw";

const req = () => ({ wallet: WALLET, launch: {} });
const expectedFee = () => withdrawFeeRaw((h.est * BigInt(1100)) / BigInt(1000), h.baseFee, h.rate, 6);

beforeEach(() => {
  h.kv.clear(); h.sent = []; h.status = "0x1"; h.launchFee = BigInt(0); h.anonOf = LAUNCHER; h.routing = true; h.rejectSession = false;
  h.est = BigInt(6_000_000);
});

describe("anon launch quote", () => {
  it("relayer's gas estimate +10%, x base fee, x the live USDG/ETH price, paid to the relayer, in USDG", async () => {
    const q = await quoteAnonFreeLaunch(req());
    expect(q.gas).toBe(String(BigInt(6_600_000)));
    expect(BigInt(q.launchGasFee)).toBe(expectedFee());
    // 6.6M gas x 0.02 gwei x $3,000 = $0.396
    expect(Number(q.launchGasFee) / 1e6).toBeCloseTo(0.396, 3);
    expect(q.feeTo.toLowerCase()).toBe(RELAYER);
  });
  it("refused while hidden launches with burn / pool fees aren't live", async () => {
    h.routing = false;
    await expect(quoteAnonFreeLaunch(req())).rejects.toMatchObject({ notSent: true });
  });
});

describe("relayAnonFreeLaunch: the launch's gas goes on the tab", () => {
  it("a landed launch is sent to the harvest and its gas is added to the tab", async () => {
    h.est = BigInt(1_500_000); // a cloned (EIP-1167) launch, well under the cap
    const r = await relayAnonFreeLaunch(req(), { idToken: "t" });
    expect(r.success).toBe(true);
    expect(h.sent).toEqual([expect.objectContaining({ to: HARVEST, data: "0xfeed" })]);
    expect(await tabOwed(WALLET)).toBe(expectedFee());
  });

  it("a reverted launch is the relayer's loss: nothing goes on the tab", async () => {
    h.est = BigInt(1_500_000);
    h.status = "0x0";
    const r = await relayAnonFreeLaunch(req(), { idToken: "t" });
    expect(r.success).toBe(false);
    expect(await tabOwed(WALLET)).toBe(BigInt(0));
  });

  it("refused, nothing sent, when the tab plus this launch would pass the cap", async () => {
    h.est = BigInt(1_500_000);
    h.kv.set(`launchtab:${(await import("../lib/chains")).ACTIVE_CHAIN.id}:${WALLET.toLowerCase()}`, String(tabMax() - BigInt(1)));
    await expect(relayAnonFreeLaunch(req(), { idToken: "t" })).rejects.toMatchObject({ notSent: true, message: expect.stringMatching(/cash out once/) });
    expect(h.sent).toHaveLength(0);
  });

  it("a launch whose gas alone is over the cap is refused (today's ~6.7M-gas launch at a high base fee)", async () => {
    h.est = BigInt(6_700_000);
    h.baseFee = BigInt(20_000_000_000); // 20 gwei
    await expect(relayAnonFreeLaunch(req(), { idToken: "t" })).rejects.toMatchObject({ notSent: true });
    expect(h.sent).toHaveLength(0);
    h.baseFee = BigInt(20_000_000);
  });

  it("a launcher that charges a launch fee is refused (anon launches are free)", async () => {
    h.launchFee = BigInt(1);
    await expect(relayAnonFreeLaunch(req(), { idToken: "t" })).rejects.toMatchObject({ notSent: true, message: expect.stringMatching(/no launch fee/) });
    expect(h.sent).toHaveLength(0);
  });

  it("a harvest wired to another launcher is refused", async () => {
    h.anonOf = "0x00000000000000000000000000000000000000ff";
    await expect(relayAnonFreeLaunch(req(), { idToken: "t" })).rejects.toMatchObject({ notSent: true, message: expect.stringMatching(/launcher mismatch/) });
    expect(h.sent).toHaveLength(0);
  });

  it("no valid sign-in: nothing sent and nothing on the tab", async () => {
    h.rejectSession = true;
    await expect(relayAnonFreeLaunch(req(), { idToken: "bad" })).rejects.toMatchObject({ notSent: true });
    expect(h.sent).toHaveLength(0);
    expect(await tabOwed(WALLET)).toBe(BigInt(0));
  });
});

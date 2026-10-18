import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { EVENTS } from "../src/abi";
import { openDb } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { Api } from "../src/api";
import { Syncer } from "../src/sync";
import { getLogsAdaptive, withRetry, RateLimiter } from "../src/rpc";
import { loadConfig, type Config, type Stack } from "../src/config";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const stack: Stack = { id: "t", fromBlock: 1n, launchpad: A(1), feeRouter: A(2), hook: A(3), migration: A(4), trampWallManager: A(5), anonLauncher: A(6), rewardsVault: A(7), referralRegistry: A(8) };
const cfg: Config = { chainId: 1, rpcUrl: "", stateView: A(9), stacks: [stack], dbPath: ":memory:", port: 0, chunk: 100n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 1n };
const TOKEN = A(0x100), CURVE = A(0x101), QUOTE = A(0x102), ALICE = A(0xa1), BOB = A(0xb0b), CAROL = A(0xca401), KEEPER = A(0xbee);
const E18 = 10n ** 18n;
let li = 0;
function mk(name: string, args: Record<string, any>, address: Hex, block = 1n): RawLog {
  const ev: any = EVENTS.find((e: any) => e.name === name)!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any);
  const nonIdx = ev.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i: any) => args[i.name]));
  return { address, topics: topics as any, data, blockNumber: block, transactionHash: `0x${(++li).toString(16).padStart(64, "0")}` as Hex, logIndex: li };
}
const ts = (b: bigint) => 1_000_000 + Number(b) * 60;
const trade = (trader: Hex, quoteAmt: bigint, priceAfter: bigint, mcap: number, src: Hex, block: bigint) =>
  mk("Trade", { token: TOKEN, trader, isBuy: true, quoteAmt, tokenAmt: E18, fee: 0n, snipeFee: 0n, priceBeforeX18: 0n, priceAfterX18: priceAfter, impactBps: 0n, mcapAfterUsd: BigInt(mcap) * E18 }, src, block);

function launchLogs(): RawLog[] {
  return [
    mk("Launched", { token: TOKEN, curve: CURVE, creator: ALICE, quote: QUOTE, name: "Coin", ticker: "C", creatorTaxBps: 0n }, stack.launchpad, 2n),
    mk("QuotePriced", { token: TOKEN, quote: QUOTE, quotePriceUsd: 2n * E18 }, stack.launchpad, 2n),
    mk("LaunchTierContext", { token: TOKEN, startMcapUsd: 5000n * E18, graduationMcapUsd: 69000n * E18, totalSupply: 10n ** 27n, decimals_: 18 }, stack.launchpad, 2n),
  ];
}

function seeded() {
  const db = openDb(":memory:");
  applyLogs(db, stack, [
    ...launchLogs(),
    mk("ReferrerPending", { wallet: BOB, referrer: CAROL }, stack.referralRegistry!, 2n),
    mk("ReferrerAttributed", { wallet: BOB, referrer: CAROL }, stack.referralRegistry!, 3n),
    mk("ReferrerPending", { wallet: BOB, referrer: ALICE }, stack.referralRegistry!, 4n), // must not downgrade
    mk("UsdgDepositRecorded", { wallet: BOB, amount: 50n * E18, total: 50n * E18 }, stack.referralRegistry!, 3n),
    mk("Transfer", { from: A(0), to: CURVE, value: 10n ** 27n }, TOKEN, 2n),
    trade(BOB, 100n * E18, 3n * E18, 6000, CURVE, 5n),
    mk("AltitudeUpdate", { token: TOKEN, mcapUsd: 6000n * E18, tier: 1 }, CURVE, 5n),
    mk("TierBreak", { token: TOKEN, fromTier: 0, toTier: 1, mcapUsd: 6000n * E18 }, CURVE, 5n),
    mk("TierBreak", { token: TOKEN, fromTier: 1, toTier: 9, mcapUsd: 1n }, A(0xbad), 5n), // spoofed emitter → ignored
    mk("Transfer", { from: CURVE, to: BOB, value: 10n ** 25n }, TOKEN, 5n),
    mk("TradeFeeRouted", { token: TOKEN, feeToken: QUOTE, trader: BOB, feeIsQuote: true, creator: ALICE, creatorShare: 4n * E18, creatorTaxAmount: 0n, lpShare: 3n * E18, treasuryShare: 2n * E18, referralPayee: CAROL, referralShare: 1n * E18, kolPayee: A(0), kolShare: 0n }, stack.feeRouter, 5n),
    // post-grad fee charged in launch-token units → must not be added to quote totals
    mk("TradeFeeRouted", { token: TOKEN, feeToken: TOKEN, trader: BOB, feeIsQuote: false, creator: ALICE, creatorShare: 40n * E18, creatorTaxAmount: 0n, lpShare: 30n * E18, treasuryShare: 20n * E18, referralPayee: CAROL, referralShare: 10n * E18, kolPayee: A(0), kolShare: 0n }, stack.feeRouter, 9n),
    mk("SnipeFeeRouted", { token: TOKEN, quote: QUOTE, toRewards: 7n * E18, toTreasury: 3n * E18 }, stack.feeRouter, 5n),
    mk("RewardAccrued", { token: TOKEN, asset: QUOTE, amount: 7n * E18 }, stack.rewardsVault!, 5n),
    mk("TrampPlaced", { id: 1n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, liquidity: 1n, quoteAmt: 600n * E18 }, stack.trampWallManager!, 6n),
    mk("KeeperTipPaid", { id: 1n, keeper: KEEPER, quoteTip: E18, tokenTip: 0n }, stack.trampWallManager!, 7n),
    mk("Filled", { id: 1n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, quoteOut: 0n, tokenOut: 5n, keeper: KEEPER }, stack.trampWallManager!, 7n),
    mk("ReferrerFeesClaimed", { quote: QUOTE, referrer: CAROL, amount: E18 }, stack.feeRouter, 8n),
  ], ts);
  return db;
}
const get = async (api: Api, path: string) => (await api.route("GET", new URL("http://x" + path)))[1] as any;

describe("PR #44 events", () => {
  it("altitude + tier breaks (curve only, spoof ignored) + launch tier context", async () => {
    const api = new Api(seeded(), null, cfg);
    const alt = await get(api, `/coins/${TOKEN}/altitude`);
    expect(alt.tier).toBe(1);
    expect(alt.mcapUsd).toBe(6000);
    expect(alt.context.graduationMcapUsd).toBe(69000);
    expect(alt.breaks).toHaveLength(1);
    expect((await get(api, "/tier-breaks"))[0]).toMatchObject({ ticker: "C", fromTier: 0, toTier: 1 });
    expect((await get(api, "/coins?sort=tier"))[0].tier).toBe(1);
  });
  it("keeper tips land on the order and keeper leaderboard", async () => {
    const api = new Api(seeded(), null, cfg);
    const [o] = await get(api, `/orders?status=filled`);
    expect(o).toMatchObject({ kind: "tramp", keeper: KEEPER, keeper_quote_tip: E18.toString() });
    expect((await get(api, "/leaderboard/keepers"))[0]).toMatchObject({ user: KEEPER, tips: 1, quoteTips: 1 });
    expect((await get(api, "/leaderboard/tramps"))[0]).toMatchObject({ user: ALICE, trampsFilled: 1 });
  });
  it("fee routing shares (creator/lp/treasury/referral) and snipe 70/30", async () => {
    const f = await get(new Api(seeded(), null, cfg), `/coins/${TOKEN}/fee-routing`);
    expect(f).toMatchObject({ creator: (4n * E18).toString(), lp: (3n * E18).toString(), treasury: (2n * E18).toString(), referral: E18.toString() });
    expect(f.snipeToRewards).toBe((7n * E18).toString());
    expect(f.usd.creator).toBe(8); // quote priced $2
  });
  it("referrals: attributed is sticky; profile aggregates", async () => {
    const api = new Api(seeded(), null, cfg);
    const r = await get(api, `/users/${BOB}/referrals`);
    expect(r.referredBy).toEqual([expect.objectContaining({ referrer: CAROL, status: "attributed" })]);
    expect(r.deposits).toHaveLength(1);
    const carol = await get(api, `/users/${CAROL}`);
    expect(carol.referrals.referred).toHaveLength(1);
    expect(carol.referrals.claims).toHaveLength(1);
    expect((await get(api, "/leaderboard/referrers"))[0]).toMatchObject({ user: CAROL, attributed: 1, referralShareQuote: 1, referralShareToken: 10 });
    const bob = await get(api, `/users/${BOB}`);
    expect(bob.holdings[0]).toMatchObject({ token: TOKEN, balance: (10n ** 25n).toString() });
    expect(bob.counters.trades).toBe(1);
  });
  it("audit #11: fee routing keeps quote and token units separate", async () => {
    const api = new Api(seeded(), null, cfg);
    const f = await get(api, `/coins/${TOKEN}/fee-routing`);
    expect(f.trades).toBe(1);
    expect(f.referral).toBe((1n * E18).toString());
    expect(f.tokenUnits).toMatchObject({ trades: 1, referral: (10n * E18).toString(), creator: (40n * E18).toString() });
  });
  it("holders and trader/creator leaderboards", async () => {
    const api = new Api(seeded(), null, cfg);
    const h = await get(api, `/coins/${TOKEN}/holders`);
    expect(h.find((x: any) => x.holder === BOB).pct).toBe(1);
    expect(h.find((x: any) => x.holder === CURVE).protocol).toBe(true);
    expect((await get(api, "/leaderboard/traders"))[0]).toMatchObject({ user: BOB, volumeUsd: 200 });
    expect((await get(api, "/leaderboard/creators"))[0]).toMatchObject({ user: ALICE, coins: 1, bestTier: 1 });
    await expect(api.route("GET", new URL("http://x/leaderboard/nope"))).rejects.toThrow(/unknown leaderboard/);
  });
  it("LPDonation is no longer decoded", () => {
    expect(EVENTS.some((e: any) => e.name === "LPDonation")).toBe(false);
  });
});

describe("rpc hygiene", () => {
  it("adaptive getLogs splits ranges the provider rejects", async () => {
    const calls: [bigint, bigint][] = [];
    const fetch = async (a: bigint, b: bigint) => {
      calls.push([a, b]);
      if (b - a + 1n > 25n) throw new Error("query exceeds max block range 25");
      return [Number(a)];
    };
    const out = await getLogsAdaptive(fetch, 0n, 99n, 1n, (f) => withRetry(f, { retries: 0 }));
    expect(out.sort((x, y) => x - y)).toEqual([0, 25, 50, 75]);
  });
  it("retries transient/429 errors with backoff", async () => {
    let n = 0;
    const v = await withRetry(async () => { if (n++ < 2) throw Object.assign(new Error("429 Too Many Requests"), { status: 429 }); return 7; }, { sleep: async () => {} });
    expect(v).toBe(7);
    expect(n).toBe(3);
  });
  it("rate limiter throttles", async () => {
    let slept = 0;
    const rl = new RateLimiter(2, async (ms) => { slept += ms; await new Promise((r) => setTimeout(r, ms)); });
    for (let i = 0; i < 4; i++) await rl.take();
    expect(slept).toBeGreaterThan(0);
  });
});

/** Fake chain: logs by block, block hashes mutable to simulate a reorg. */
function fakeClient(logsByBlock: Map<bigint, RawLog[]>, head: () => bigint, hashOf: (b: bigint) => Hex) {
  return {
    getBlockNumber: async () => head(),
    getBlock: async ({ blockNumber }: any) => ({ number: blockNumber, timestamp: BigInt(ts(blockNumber)), hash: hashOf(blockNumber) }),
    getLogs: async ({ address, fromBlock, toBlock }: any) => {
      const set = new Set((address as string[]).map((x) => x.toLowerCase()));
      const out: RawLog[] = [];
      for (let b = fromBlock; b <= toBlock; b++) for (const l of logsByBlock.get(b) ?? []) if (set.has(l.address.toLowerCase())) out.push(l);
      return out;
    },
  } as any;
}

describe("sync: backfill, atomic chunks, reorg rebuild", () => {
  it("discovers coins launched mid-chunk and indexes their curve/token logs in the same chunk", async () => {
    const m = new Map<bigint, RawLog[]>();
    m.set(2n, launchLogs());
    m.set(3n, [mk("Transfer", { from: A(0), to: CURVE, value: 10n ** 27n }, TOKEN, 3n), trade(BOB, E18, E18, 5000, CURVE, 3n), mk("Transfer", { from: CURVE, to: BOB, value: 5n }, TOKEN, 3n)]);
    const db = openDb(":memory:");
    const s = new Syncer(db, fakeClient(m, () => 10n, (b) => `0x${b.toString(16).padStart(64, "a")}` as Hex), { ...cfg, chunk: 1000n }, () => {});
    await s.syncAll();
    expect((db.prepare("SELECT COUNT(*) n FROM trades").get() as any).n).toBe(1);
    expect((db.prepare("SELECT bal FROM balances WHERE holder=?").get(BOB.toLowerCase()) as any).bal).toBe("5");
    await s.syncAll(); // idempotent second pass
    expect((db.prepare("SELECT bal FROM balances WHERE holder=?").get(BOB.toLowerCase()) as any).bal).toBe("5");
  });
  it("detects a reorg via cursor block hash and rebuilds the stack from the new canonical chain", async () => {
    const m = new Map<bigint, RawLog[]>();
    m.set(2n, launchLogs());
    m.set(3n, [trade(BOB, E18, E18, 5000, CURVE, 3n)]);
    let fork = "a";
    let head = 5n;
    const db = openDb(":memory:");
    const msgs: string[] = [];
    const s = new Syncer(db, fakeClient(m, () => head, (b) => `0x${b.toString(16).padStart(63, "0")}${b >= 3n ? fork : "0"}` as Hex), { ...cfg, chunk: 2n }, (x) => msgs.push(x));
    await s.syncAll();
    expect((db.prepare("SELECT COUNT(*) n FROM trades").get() as any).n).toBe(1);
    // reorg: block 3's trade disappears, a different trade lands at block 4
    fork = "b";
    m.set(3n, []);
    m.set(4n, [trade(ALICE, 2n * E18, E18, 5000, CURVE, 4n)]);
    head = 6n;
    await s.syncAll();
    expect(msgs.some((x) => x.includes("REORG"))).toBe(true);
    const rows = db.prepare("SELECT trader FROM trades").all() as any[];
    expect(rows.map((r) => r.trader)).toEqual([ALICE.toLowerCase()]);
  });
});

describe("config", () => {
  it("loads web-bundle addresses.json, STACKS filter, START_BLOCK override", () => {
    const p = new URL("../../contracts/deployments/web-bundle/addresses.json", import.meta.url).pathname;
    const c = loadConfig({ DEPLOYMENT_JSON: p, STACK_ID: "v4", RPC_URL: "http://rpc" } as any);
    expect(c.stacks).toHaveLength(1);
    expect(c.stacks[0]).toMatchObject({ id: "v4", fromBlock: 137540728n, launchpad: "0x4f540bc1585ca36c8a49662dc642f6e28ae534da", referralRegistry: "0x0aa4dfb57deb37ada6de375da06aba5dc2099a9c",
      usdgDepositNotifier: "0xaf5d4a15ee996140e83179952f0a0cf46c93f6d9", loginGate: "0xe900b7060895f130e866eeddec2b3efd3ff0b69f" });
    // main json: v4 newest (PR #97) with v3 → v1 as previous stacks; START_BLOCK overrides the newest only
    expect(loadConfig({} as any).stacks.map((x) => x.id)).toEqual(["v1", "v2", "v3", "v4"]);
    const all = loadConfig({ STACKS: "v4", START_BLOCK: "137540800" } as any);
    expect(all.stacks.map((x) => x.id)).toEqual(["v4"]);
    expect(all.stacks[0].fromBlock).toBe(137540800n);
    expect(loadConfig({ STACKS: "v3" } as any).stacks[0].fromBlock).toBe(136187963n);
  });
});

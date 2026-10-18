import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { EVENTS } from "../src/abi";
import { openDb } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { Api } from "../src/api";
import type { Config, Stack } from "../src/config";

/** Creator fees, crew (PVE profit tax) and referral-gate indexing: v3 + redeploy (feat/modes-gas) event shapes. */
const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const stack: Stack = { id: "t", fromBlock: 0n, launchpad: A(1), feeRouter: A(2), hook: A(3), referralRegistry: A(8), depositNotifier: A(10) };
const cfg: Config = { chainId: 1, rpcUrl: "", stateView: A(9), stacks: [stack], dbPath: ":memory:", port: 0, chunk: 1000n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 10n };
const TOKEN = A(0x100), CURVE = A(0x101), QUOTE = A(0x102), ALICE = A(0xa1), BOB = A(0xb0b), CAROL = A(0xc4);
const E18 = 10n ** 18n;
let li = 0;
/** `pick` chooses among overloads (TradeFeeRouted v3 vs redeploy). */
function mk(name: string, args: Record<string, any>, address: Hex, block = 1n, pick?: (e: any) => boolean): RawLog {
  const ev: any = EVENTS.find((e: any) => e.type === "event" && e.name === name && (!pick || pick(e)))!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any);
  const nonIdx = ev.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i: any) => args[i.name]));
  return { address, topics: topics as any, data, blockNumber: block, transactionHash: `0x${(++li).toString(16).padStart(64, "0")}` as Hex, logIndex: li };
}
const isNext = (e: any) => e.inputs.some((i: any) => i.name === "feeIsQuote");
const ts = (b: bigint) => 1_000_000 + Number(b) * 60;

function seeded() {
  const db = openDb(":memory:");
  applyLogs(db, stack, [
    mk("Launched", { token: TOKEN, curve: CURVE, creator: ALICE, quote: QUOTE, name: "Coin", ticker: "C", creatorTaxBps: 100n }, stack.launchpad),
    mk("QuotePriced", { token: TOKEN, quote: QUOTE, quotePriceUsd: 2n * E18 }, stack.launchpad),
    mk("LaunchMode", { token: TOKEN, curve: CURVE, mode: 1 }, stack.launchpad),
  ], ts);
  applyLogs(db, stack, [
    // v3 shape
    mk("TradeFeeRouted", { token: TOKEN, quote: QUOTE, trader: BOB, creatorShare: 3n * E18, lpShare: 1n, treasuryShare: 2n, referralShare: 3n, creatorTaxAmount: 1n * E18 }, stack.feeRouter, 2n, (e) => !isNext(e)),
    // redeploy shape, quote side + token side
    mk("TradeFeeRouted", { token: TOKEN, feeToken: QUOTE, trader: CAROL, feeIsQuote: true, creator: ALICE, creatorShare: 2n * E18, creatorTaxAmount: 0n, lpShare: 1n, treasuryShare: 1n, referralPayee: A(0), referralShare: 0n, kolPayee: A(0), kolShare: 0n }, stack.feeRouter, 3n, isNext),
    mk("TradeFeeRouted", { token: TOKEN, feeToken: TOKEN, trader: CAROL, feeIsQuote: false, creator: ALICE, creatorShare: 500n, creatorTaxAmount: 0n, lpShare: 1n, treasuryShare: 1n, referralPayee: A(0), referralShare: 0n, kolPayee: A(0), kolShare: 0n }, stack.feeRouter, 4n, isNext),
    // spoofed emitter → ignored
    mk("TradeFeeRouted", { token: TOKEN, quote: QUOTE, trader: BOB, creatorShare: 999n * E18, lpShare: 0n, treasuryShare: 0n, referralShare: 0n, creatorTaxAmount: 0n }, A(0xdead), 4n, (e) => !isNext(e)),
    mk("CreatorFeesClaimed", { token: TOKEN, creator: ALICE, amount: 4n * E18 }, stack.feeRouter, 5n),
    mk("CreatorFeesClaimed", { token: TOKEN, creator: ALICE, amount: 7n * E18 }, A(0xdead), 5n), // spoof
    mk("CreatorTokenFeesClaimed", { token: TOKEN, creator: ALICE, amount: 200n }, stack.feeRouter, 6n),
    // PVE crew pool
    mk("ProfitTaxCharged", { token: TOKEN, seller: BOB, tax: 777n * 10n ** 15n, grossQuote: 100n * E18, costBasis: 50n * E18 }, CURVE, 7n),
    mk("ProfitTaxCharged", { token: TOKEN, seller: BOB, tax: 1n * E18, grossQuote: 1n, costBasis: 1n }, A(0xbad), 7n), // not the curve
    mk("Transfer", { from: A(0), to: CAROL, value: 5n * E18 }, TOKEN, 7n),
    mk("HolderRewardsClaimed", { token: TOKEN, holder: CAROL, amount: 3n * 10n ** 17n }, CURVE, 8n),
    // referral gate
    mk("ReferrerPending", { wallet: CAROL, referrer: ALICE }, stack.referralRegistry!, 9n),
    mk("Deposited", { payer: CAROL, wallet: CAROL, amount: 10n * E18 }, stack.depositNotifier!, 10n),
    mk("Escrowed", { wallet: CAROL, id: 0n, amount: 10n * E18, unlockAt: 1_000_000n + 7n * 86400n }, stack.depositNotifier!, 10n),
    mk("UsdgDepositRecorded", { wallet: CAROL, amount: 10n * E18, total: 10n * E18 }, stack.referralRegistry!, 10n),
    mk("ReferrerAttributed", { wallet: CAROL, referrer: ALICE }, stack.referralRegistry!, 10n),
    mk("Escrowed", { wallet: CAROL, id: 1n, amount: 99n * E18, unlockAt: 1n }, A(0xdead), 10n), // spoof notifier
  ], ts);
  return db;
}

describe("creator fees", () => {
  it("normalizes both TradeFeeRouted signatures and keeps token-side fees apart", () => {
    const db = seeded();
    const rows = db.prepare("SELECT kind, account, quote, a, e FROM fee_events WHERE kind LIKE 'TradeFeeRouted%' ORDER BY block").all() as any[];
    expect(rows.map((r) => r.kind)).toEqual(["TradeFeeRouted", "TradeFeeRouted", "TradeFeeRoutedToken"]);
    expect(rows[0]).toMatchObject({ account: BOB, quote: QUOTE, a: (3n * E18).toString(), e: E18.toString() });
    expect(rows[2]).toMatchObject({ quote: TOKEN, a: "500" });
  });
  it("/creators/:addr/fees: lifetime earned, claimed, recent accruals (no RPC ⇒ claimable null)", async () => {
    const api = new Api(seeded(), null, cfg);
    const [st, body]: any = await api.route("GET", new URL(`http://x/creators/${ALICE}/fees?recent=5`));
    expect(st).toBe(200);
    expect(body.coins).toHaveLength(1);
    const c = body.coins[0];
    expect(c.lifetimeEarned).toBe((6n * E18).toString()); // 3 + 1 tax (v3) + 2 (redeploy quote side)
    expect(c.lifetimeEarnedUsd).toBe(12);
    expect(c.claimed).toBe((4n * E18).toString()); // spoofed claim ignored
    expect(c.claimedUsd).toBe(8);
    expect(c.claimable).toBeNull();
    expect(c.mode).toBe(1);
    expect(c.token_).toMatchObject({ lifetimeEarned: "500", claimed: "200" });
    expect(c.recent).toHaveLength(3);
    expect(c.recent[0].kind).toBe("TradeFeeRoutedToken");
  });
  it("other wallets and bad addresses", async () => {
    const api = new Api(seeded(), null, cfg);
    const [, b]: any = await api.route("GET", new URL(`http://x/creators/${BOB}/fees`));
    expect(b.coins).toEqual([]);
    const [st]: any = await api.route("GET", new URL(`http://x/creators/not-an-address/fees`));
    expect(st).toBe(404);
  });
});

describe("crew (PVE profit tax)", () => {
  it("feed from the coin's own curve only, with totals", async () => {
    const api = new Api(seeded(), null, cfg);
    const [, c]: any = await api.route("GET", new URL(`http://x/coins/${TOKEN}/crew`));
    expect(c.feed).toHaveLength(1);
    expect(c.feed[0]).toMatchObject({ seller: BOB, tax: (777n * 10n ** 15n).toString() });
    expect(c.feed[0].taxUsd).toBeCloseTo(1.554, 6);
    expect(c.totalClaimed).toBe((3n * 10n ** 17n).toString());
    const [, u]: any = await api.route("GET", new URL(`http://x/users/${CAROL}/crew`));
    expect(u.claims).toHaveLength(1);
    expect(u.coins.map((x: any) => x.token)).toEqual([TOKEN]);
  });
});

describe("referral gate", () => {
  it("pending → locked, deposits and escrows from the notifier only", async () => {
    const api = new Api(seeded(), null, cfg);
    const [, g]: any = await api.route("GET", new URL(`http://x/users/${CAROL}/referral-gate`));
    expect(g).toMatchObject({ status: "locked", referrer: ALICE, depositedTotal: (10n * E18).toString(), heldNow: (10n * E18).toString() });
    expect(g.escrows).toHaveLength(1);
    expect(g.escrows[0]).toMatchObject({ id: 0, unlockAt: 1_000_000 + 7 * 86400 });
    const [, b]: any = await api.route("GET", new URL(`http://x/users/${BOB}/referral-gate`));
    expect(b.status).toBe("none");
  });
  it("withdrawn reduces held amount", async () => {
    const db = seeded();
    applyLogs(db, stack, [mk("Withdrawn", { wallet: CAROL, amount: 10n * E18 }, stack.depositNotifier!, 20n)], ts);
    const [, g]: any = await new Api(db, null, cfg).route("GET", new URL(`http://x/users/${CAROL}/referral-gate`));
    expect(g.heldNow).toBe("0");
    expect(g.withdrawnTotal).toBe((10n * E18).toString());
  });
});

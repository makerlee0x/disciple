// v4 (PR #97) additions: hook Trade with sqrtPriceAfter, LaunchMode, PVE profit tax / holder rewards, creator token-fee
// claims, UsdgDepositNotifier escrow, and the /coins/:t/profit-tax, /users/:a/rewards, /users/:a/referral endpoints.
import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { EVENTS } from "../src/abi";
import { openDb, wipeStack } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { Api } from "../src/api";
import { tradeUsd } from "../src/usd";
import { mcapUsdFromSqrt, TOTAL_SUPPLY } from "../src/math";
import type { Config, Stack } from "../src/config";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const stack: Stack = { id: "v4", fromBlock: 1n, launchpad: A(1), feeRouter: A(2), hook: A(3), referralRegistry: A(8), usdgDepositNotifier: A(9) };
const cfg: Config = { chainId: 1, rpcUrl: "", stateView: A(0x99), stacks: [stack], dbPath: ":memory:", port: 0, chunk: 100n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 1n };
// token < quote ⇒ tokenIsC0
const TOKEN = A(0x100), CURVE = A(0x101), QUOTE = A(0x9000), ALICE = A(0xa1), BOB = A(0xb0b), CAROL = A(0xca401), DAVE = A(0xd0);
const E18 = 10n ** 18n, Q96 = 1n << 96n;
let li = 0;
function mk(name: string, args: Record<string, any>, address: Hex, block = 1n, pick?: (e: any) => boolean): RawLog {
  const ev: any = EVENTS.find((e: any) => e.type === "event" && e.name === name && (!pick || pick(e)))!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any);
  const nonIdx = ev.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i: any) => args[i.name]));
  return { address, topics: topics as any, data, blockNumber: block, transactionHash: `0x${(++li).toString(16).padStart(64, "0")}` as Hex, logIndex: li };
}
/** deposit() emits Deposited + Escrowed in one tx */
const sameTx = (...ls: RawLog[]) => ls.map((l) => ({ ...l, transactionHash: ls[0].transactionHash }));
const isHook = (e: any) => e.inputs.at(-1).name === "sqrtPriceAfter";
const base = { fee: 0n, snipeFee: 0n, priceBeforeX18: 0n, impactBps: 0n };
const ts = (b: bigint) => 1_000_000 + Number(b) * 60;

function seeded() {
  const db = openDb(":memory:");
  const launchTx: RawLog[] = [
    mk("LaunchMode", { token: TOKEN, curve: CURVE, mode: 1 }, stack.launchpad, 2n), // emitted BEFORE Launched
    mk("Launched", { token: TOKEN, curve: CURVE, creator: ALICE, quote: QUOTE, name: "Pve", ticker: "PVE", creatorTaxBps: 0n }, stack.launchpad, 2n),
    mk("QuotePriced", { token: TOKEN, quote: QUOTE, quotePriceUsd: 2n * E18 }, stack.launchpad, 2n),
    mk("LaunchTierContext", { token: TOKEN, startMcapUsd: 7000n * E18, graduationMcapUsd: 69000n * E18, totalSupply: TOTAL_SUPPLY, decimals_: 18 }, stack.launchpad, 2n),
  ];
  applyLogs(db, stack, [
    ...launchTx,
    mk("Transfer", { from: A(0), to: CURVE, value: TOTAL_SUPPLY }, TOKEN, 2n),
    mk("Trade", { token: TOKEN, trader: BOB, isBuy: true, quoteAmt: 10n * E18, tokenAmt: E18, ...base, priceAfterX18: E18, mcapAfterUsd: 7001n * E18 }, CURVE, 3n, (e) => !isHook(e)),
    mk("Transfer", { from: CURVE, to: BOB, value: 10n ** 24n }, TOKEN, 3n),
    mk("ProfitTaxCharged", { token: TOKEN, seller: BOB, tax: 3n * E18, grossQuote: 40n * E18, costBasis: 10n * E18 }, CURVE, 4n),
    mk("ProfitTaxCharged", { token: TOKEN, seller: BOB, tax: 99n * E18, grossQuote: 1n, costBasis: 1n }, A(0xbad), 4n), // spoofed
    mk("HolderRewardsClaimed", { token: TOKEN, holder: CAROL, amount: E18 }, CURVE, 5n),
    mk("HolderRewardsClaimed", { token: TOKEN, holder: CAROL, amount: 50n * E18 }, A(0xbad), 5n), // spoofed
    // post-grad v4 hook trade: price 1 quote/token (sqrtP = Q96, tokenIsC0)
    mk("Trade", { token: TOKEN, trader: DAVE, isBuy: true, quoteAmt: 5n * E18, tokenAmt: 5n * E18, ...base, priceAfterX18: E18, sqrtPriceAfter: Q96 }, stack.hook, 6n, isHook),
    mk("Trade", { token: TOKEN, trader: DAVE, isBuy: true, quoteAmt: 5n * E18, tokenAmt: 5n * E18, ...base, priceAfterX18: E18, sqrtPriceAfter: Q96 }, CURVE, 6n, isHook), // only the hook may emit it
    mk("CreatorFeesClaimed", { token: TOKEN, creator: ALICE, amount: 2n * E18 }, stack.feeRouter, 7n),
    mk("CreatorTokenFeesClaimed", { token: TOKEN, creator: ALICE, amount: 7n * E18 }, stack.feeRouter, 7n),
    // referral: BOB referred by CAROL; DAVE funds BOB's $10 escrow, BOB later withdraws one $10 entry
    mk("ReferrerPending", { wallet: BOB, referrer: CAROL }, stack.referralRegistry!, 8n),
    mk("UsdgDepositRecorded", { wallet: BOB, amount: 10_000_000n, total: 10_000_000n }, stack.referralRegistry!, 8n),
    mk("ReferrerAttributed", { wallet: BOB, referrer: CAROL }, stack.referralRegistry!, 8n),
    ...sameTx(
      mk("Deposited", { payer: DAVE, wallet: BOB, amount: 10_000_000n }, stack.usdgDepositNotifier!, 8n),
      mk("Escrowed", { wallet: BOB, id: 0n, amount: 10_000_000n, unlockAt: BigInt(ts(8n) + 7 * 86400) }, stack.usdgDepositNotifier!, 8n),
    ),
    mk("Escrowed", { wallet: BOB, id: 1n, amount: 20_000_000n, unlockAt: BigInt(ts(9n) + 7 * 86400) }, stack.usdgDepositNotifier!, 9n),
    mk("Withdrawn", { wallet: BOB, amount: 10_000_000n }, stack.usdgDepositNotifier!, 10n),
    mk("Withdrawn", { wallet: BOB, amount: 999n }, A(0xbad), 10n), // spoofed
    mk("TradeFeeRouted", { token: TOKEN, feeToken: QUOTE, trader: BOB, feeIsQuote: true, creator: ALICE, creatorShare: 4n * E18, creatorTaxAmount: 0n, lpShare: 3n * E18, treasuryShare: 2n * E18, referralPayee: CAROL, referralShare: E18, kolPayee: A(0), kolShare: 0n }, stack.feeRouter, 3n),
  ], ts);
  return db;
}

describe("v4 usd: hook Trade with sqrtPriceAfter", () => {
  it("mcap from sqrtPriceAfter (both currency orders); curve Trade keeps mcapAfterUsd", () => {
    const q = (2n * E18).toString();
    const c0 = tradeUsd({ quotePriceUsdWad: q, quoteAmt: 5n * E18, priceAfterX18: 0n, sqrtPriceAfter: Q96, token: TOKEN, quote: QUOTE });
    expect(c0.priceUsd).toBeCloseTo(2, 9);
    expect(c0.volumeUsd).toBe(10);
    expect(BigInt(c0.mcapUsdWad)).toBe(TOTAL_SUPPLY * 2n); // 1M tokens × 1 quote × $2
    // token > quote ⇒ token is currency1: price = 1/p²; sqrtP = 2·Q96 ⇒ 0.25 quote/token
    const c1 = tradeUsd({ quotePriceUsdWad: q, quoteAmt: 0n, priceAfterX18: 0n, sqrtPriceAfter: 2n * Q96, token: QUOTE, quote: TOKEN });
    expect(c1.priceUsd).toBeCloseTo(0.5, 9);
    expect(BigInt(c1.mcapUsdWad)).toBe(mcapUsdFromSqrt(2n * Q96, false, 2n * E18));
    expect(tradeUsd({ quotePriceUsdWad: q, quoteAmt: 0n, priceAfterX18: E18, mcapAfterUsd: 7n * E18 }).mcapUsdWad).toBe((7n * E18).toString());
  });
});

describe("v4 ingest", () => {
  it("decodes curve + hook Trade overloads; hook variant only from the hook; mode from LaunchMode", () => {
    const db = seeded();
    const coin: any = db.prepare("SELECT * FROM coins").get();
    expect(coin.mode).toBe(1);
    const tr = db.prepare("SELECT source, trader, CAST(mcap_usd AS REAL)/1e18 m, price_usd p FROM trades ORDER BY block").all() as any[];
    expect(tr.map((t) => t.source)).toEqual(["curve", "hook"]);
    expect(tr[0].m).toBe(7001);
    expect(tr[1].m).toBeCloseTo(2e6, -3); // 1M × $2
    expect(tr[1].p).toBeCloseTo(2, 9);
    const st: any = db.prepare("SELECT trades, last_mcap FROM coin_stats").get();
    expect(st.trades).toBe(2);
    expect(st.last_mcap).toBeCloseTo(2e6, -3);
  });
  it("profit tax / holder rewards only from the coin's curve; notifier only from the notifier; wipe clears them", () => {
    const db = seeded();
    expect((db.prepare("SELECT COUNT(*) n FROM profit_tax").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM holder_rewards").get() as any).n).toBe(1);
    expect((db.prepare("SELECT kind FROM usdg_escrow_events ORDER BY block, id").all() as any[]).map((r) => r.kind)).toEqual(["Deposited", "Escrowed", "Escrowed", "Withdrawn"]);
    expect((db.prepare("SELECT COUNT(*) n FROM fee_events WHERE kind='CreatorTokenFeesClaimed'").get() as any).n).toBe(1);
    wipeStack(db, "v4");
    for (const t of ["profit_tax", "holder_rewards", "usdg_escrow_events"]) expect((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n).toBe(0);
  });
});

describe("v4 endpoints", () => {
  it("/coins/:token/profit-tax", async () => {
    const api = new Api(seeded(), null, cfg);
    const [st, b]: any = await api.route("GET", new URL(`http://x/coins/${TOKEN}/profit-tax`));
    expect(st).toBe(200);
    expect(b).toMatchObject({ mode: 1, count: 1, sellers: 1, totalTax: (3n * E18).toString(), totalGross: (40n * E18).toString(), totalCostBasis: (10n * E18).toString(),
      holderRewardsClaimed: E18.toString(), unclaimedEstimate: (2n * E18).toString() });
    expect(b.usd.totalTax).toBe(6);
    expect(b.events[0].seller).toBe(BOB.toLowerCase());
    expect((await api.route("GET", new URL(`http://x/coins/${A(0x777)}/profit-tax`)))[0]).toBe(404);
  });
  it("/users/:addr/rewards", async () => {
    const api = new Api(seeded(), null, cfg);
    const [, carol]: any = await api.route("GET", new URL(`http://x/users/${CAROL}/rewards`));
    expect(carol.holderRewards.claimed).toEqual([{ token: TOKEN.toLowerCase(), ticker: "PVE", quote: QUOTE.toLowerCase(), claims: 1, amount: E18.toString() }]);
    expect(carol.holderRewards.pending).toEqual([{ token: TOKEN.toLowerCase(), ticker: "PVE", quote: QUOTE.toLowerCase(), pending: null, pendingUsd: null }]); // no RPC client
    expect(carol.feeCredits).toEqual([{ role: "referral", units: "quote", feeToken: QUOTE.toLowerCase(), count: 1, amount: E18.toString() }]);
    const [, bob]: any = await api.route("GET", new URL(`http://x/users/${BOB}/rewards`));
    expect(bob.profitTaxPaid).toEqual([{ token: TOKEN.toLowerCase(), ticker: "PVE", quote: QUOTE.toLowerCase(), sells: 1, tax: (3n * E18).toString() }]);
    expect(bob.holderRewards.pending.map((p: any) => p.token)).toEqual([TOKEN.toLowerCase()]); // holds a PVE coin
    const [, alice]: any = await api.route("GET", new URL(`http://x/users/${ALICE}/rewards`));
    expect(alice.creatorFeesClaimed.sort((a: any, b: any) => a.units.localeCompare(b.units))).toEqual([
      { token: TOKEN.toLowerCase(), units: "quote", claims: 1, amount: (2n * E18).toString() },
      { token: TOKEN.toLowerCase(), units: "token", claims: 1, amount: (7n * E18).toString() },
    ]);
  });
  it("/users/:addr/referral", async () => {
    const api = new Api(seeded(), null, cfg);
    const bob: any = api.userReferral(BOB, ts(8n) + 7 * 86400 + 30); // entry 0 unlocked, entry 1 still locked
    expect(bob.referredBy[0]).toMatchObject({ referrer: CAROL.toLowerCase(), status: "attributed" });
    expect(bob.usdgGate).toMatchObject({ depositedTotal: "10000000", escrowedNow: "20000000", withdrawn: "10000000", attested: "0" });
    expect(bob.usdgGate.escrows.map((e: any) => [e.id, e.unlocked, e.fundedBy])).toEqual([[0, true, DAVE.toLowerCase()], [1, false, null]]);
    const [st, carol]: any = await api.route("GET", new URL(`http://x/users/${CAROL}/referral`));
    expect(st).toBe(200);
    expect(carol.referred).toMatchObject({ total: 1, attributed: 1, pending: 0 });
    expect(carol.earnings.quoteUnits).toBe(E18.toString());
  });
});

import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { EVENTS } from "../src/abi";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, recomputeWallUsd } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { Api } from "../src/api";
import { candles, mcapUsdWad, midRangePrice, priceWadFromSqrt, tokenIsCurrency0, virtualQuoteReserve, wallUsd } from "../src/math";
import { TRAMP_WALL_POINTS_PER_USD, type Config, type Stack } from "../src/config";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const stack: Stack = { id: "t", fromBlock: 0n, launchpad: A(1), feeRouter: A(2), hook: A(3), migration: A(4), trampWallManager: A(5), anonLauncher: A(6), rewardsVault: A(7) };
const cfg: Config = { chainId: 1, rpcUrl: "", stateView: A(9), stacks: [stack], dbPath: ":memory:", port: 0, chunk: 1000n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 10n };
const TOKEN = A(0x100), CURVE = A(0x101), QUOTE = A(0x102), ALICE = A(0xa1), BOB = A(0xb0b);
let li = 0;
function mk(name: string, args: Record<string, any>, address: Hex, block = 1n): RawLog {
  const ev: any = EVENTS.find((e: any) => e.name === name)!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any);
  const nonIdx = ev.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i: any) => args[i.name]));
  return { address, topics: topics as any, data, blockNumber: block, transactionHash: `0x${(++li).toString(16).padStart(64, "0")}` as Hex, logIndex: li };
}
const trade = (trader: Hex, isBuy: boolean, quoteAmt: bigint, priceAfter: bigint, src: Hex, block: bigint) =>
  mk("Trade", { token: TOKEN, trader, isBuy, quoteAmt, tokenAmt: 1n, fee: 0n, snipeFee: 0n, priceBeforeX18: 0n, priceAfterX18: priceAfter, impactBps: 0n, mcapAfterUsd: 33_000n * 10n ** 18n }, src, block);

function seeded() {
  const db = openDb(":memory:");
  const ts = (b: bigint) => 1_000_000 + Number(b) * 60;
  applyLogs(db, stack, [
    mk("Launched", { token: TOKEN, curve: CURVE, creator: ALICE, quote: QUOTE, name: "Coin", ticker: "C", creatorTaxBps: 0n }, stack.launchpad),
    mk("QuotePriced", { token: TOKEN, quote: QUOTE, quotePriceUsd: 10n ** 18n }, stack.launchpad),
    mk("Launched", { token: A(0x999), curve: A(0x998), creator: BOB, quote: QUOTE, name: "Spoof", ticker: "S", creatorTaxBps: 0n }, A(0xdead)),
  ], ts);
  applyLogs(db, stack, [
    mk("Transfer", { from: A(0), to: CURVE, value: 7n * 10n ** 27n }, TOKEN),
    trade(BOB, true, 100n * 10n ** 18n, 2n * 10n ** 18n, CURVE, 2n),
    mk("Transfer", { from: CURVE, to: BOB, value: 10n ** 18n }, TOKEN, 2n),
    trade(BOB, false, 50n * 10n ** 18n, 1n * 10n ** 18n, CURVE, 3n),
    trade(ALICE, true, 10n * 10n ** 18n, 3n * 10n ** 18n, A(0xbad), 3n), // not curve, not hook → ignored
    mk("GraduatedToV4", { token: TOKEN, poolId: `0x${"ab".repeat(32)}`, tokenLiq: 1n, quoteLiq: 1n }, CURVE, 4n),
    trade(BOB, true, 2000n * 10n ** 18n, 4n * 10n ** 18n, stack.hook, 70n),
  ], ts);
  applyLogs(db, stack, [
    mk("TrampPlaced", { id: 1n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, liquidity: 1n, quoteAmt: 1500n * 10n ** 18n }, stack.trampWallManager!, 71n),
    mk("TrampPlaced", { id: 2n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, liquidity: 1n, quoteAmt: 10n * 10n ** 18n }, stack.trampWallManager!, 71n),
    mk("WallPlaced", { id: 3n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, liquidity: 1n, tokenAmt: 5n * 10n ** 18n }, stack.trampWallManager!, 71n),
    mk("Filled", { id: 1n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, quoteOut: 0n, tokenOut: 1n, keeper: BOB }, stack.trampWallManager!, 72n),
    mk("Filled", { id: 2n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, quoteOut: 0n, tokenOut: 1n, keeper: BOB }, stack.trampWallManager!, 72n),
    mk("Cancelled", { id: 3n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, quoteOut: 0n, tokenOut: 1n, quoteFees: 0n, tokenFees: 0n }, stack.trampWallManager!, 72n),
    mk("FeesClaimed", { id: 1n, owner: ALICE, token: TOKEN, quoteFees: 7n, tokenFees: 9n }, stack.trampWallManager!, 73n),
    mk("SnipeFeeRouted", { token: TOKEN, quote: QUOTE, toRewards: 70n, toTreasury: 30n }, stack.feeRouter, 73n),
  ], ts);
  return db;
}

describe("math", () => {
  it("price from sqrt both orientations + mcap", () => {
    const Q96 = 1n << 96n;
    expect(priceWadFromSqrt(Q96, true)).toBe(10n ** 18n);
    expect(priceWadFromSqrt(2n * Q96, true)).toBe(4n * 10n ** 18n);
    expect(priceWadFromSqrt(2n * Q96, false)).toBe(25n * 10n ** 16n);
    expect(mcapUsdWad(10n ** 18n, 10n ** 18n)).toBe(7_000_000_000n * 10n ** 18n);
    expect(virtualQuoteReserve(1000n, Q96, true)).toBe(1000n);
  });
  it("TRMP-like pool price ~ $45.3K", () => {
    // live TRMP slot0 (token is currency1) and STRATEGY = $0.00245
    const p = priceWadFromSqrt(1541825069166933097153735021859n, false);
    const m = Number(mcapUsdWad(p, 2450000000000000n)) / 1e18;
    expect(m).toBeGreaterThan(45_000);
    expect(m).toBeLessThan(45_600);
  });
  it("candles OHLC + continuity", () => {
    const c = candles([{ ts: 0, price: 1, vol: 1 }, { ts: 30, price: 3, vol: 1 }, { ts: 61, price: 2, vol: 2 }], 60);
    expect(c).toEqual([{ t: 0, o: 1, h: 3, l: 1, c: 3, v: 2, n: 2 }, { t: 60, o: 3, h: 3, l: 2, c: 2, v: 2, n: 1 }]);
  });
});

describe("ingest + api", () => {
  it("indexes coins only from the stack launchpad", () => {
    const db = seeded();
    const coins = db.prepare("SELECT * FROM coins").all() as any[];
    expect(coins.map((c) => c.ticker)).toEqual(["C"]);
    expect(coins[0].graduated).toBe(1);
  });
  it("trades from curve and hook only, with USD", () => {
    const db = seeded();
    const t = db.prepare("SELECT source, volume_usd, price_usd FROM trades ORDER BY block").all() as any[];
    expect(t.map((x) => x.source)).toEqual(["curve", "curve", "hook"]);
    expect(t[2].volume_usd).toBe(2000);
    expect(t[2].price_usd).toBe(4);
  });
  it("counters: tramps/walls filled and big tramps >= $1K", async () => {
    const api = new Api(seeded(), null, cfg);
    const [, c]: any = await api.route("GET", new URL(`http://x/users/${ALICE}/counters`));
    expect(c).toMatchObject({ trampsPlaced: 2, wallsPlaced: 1, trampsFilled: 2, wallsFilled: 0, bigTrampsFilled: 1 });
    const [, o]: any = await api.route("GET", new URL(`http://x/coins/${TOKEN}/orders`));
    const t1 = o.find((x: any) => x.id === 1);
    expect([t1.fees_quote, t1.fees_token]).toEqual(["7", "9"]);
    // wall: 5 tokens × the price at the middle of ticks [0, 60] (token is currency0: 1.0001^30) × quote $1
    expect(o.find((x: any) => x.id === 3).amount_in_usd).toBeCloseTo(5 * 1.0001 ** 30, 9);
  });
  it("holders exclude curve; candles and list endpoints", async () => {
    const api = new Api(seeded(), null, cfg);
    const coin = api.coin(TOKEN);
    expect(api.tierInputs(coin, 1_000_000 + 100 * 60)).toMatchObject({ holders: 1, trades: 3, volumeUsd: 2150 });
    const [, cs]: any = await api.route("GET", new URL(`http://x/coins/${TOKEN}/candles?interval=1h`));
    expect(cs.length).toBeGreaterThan(0);
    const [, list]: any = await api.route("GET", new URL("http://x/coins?sort=volume"));
    expect(list[0].ticker).toBe("C");
    const [, rw]: any = await api.route("GET", new URL("http://x/rewards"));
    expect(rw[0].kind).toBe("SnipeFeeRouted");
    const [st]: any = await api.route("GET", new URL("http://x/nope"));
    expect(st).toBe(404);
  });
});

describe("tramp/wall points (filled USD) and mid-range wall USD", () => {
  const E18 = 10n ** 18n;
  // a filled wall with a fractional $ size: 1000.5 tokens over ticks [600, 1200] (mid 900)
  const WALL4_USD = 1000.5 * 1.0001 ** 900;
  function withFilledWall() {
    const db = seeded();
    applyLogs(db, stack, [
      mk("WallPlaced", { id: 4n, owner: ALICE, token: TOKEN, tickLower: 600, tickUpper: 1200, liquidity: 1n, tokenAmt: 10005n * E18 / 10n }, stack.trampWallManager!, 80n),
      mk("Filled", { id: 4n, owner: ALICE, token: TOKEN, tickLower: 600, tickUpper: 1200, quoteOut: 1n, tokenOut: 0n, keeper: BOB }, stack.trampWallManager!, 81n),
      // BOB: an active tramp (price inside its range, not pulled) and a partly filled tramp he cancelled → both earn 0
      mk("TrampPlaced", { id: 5n, owner: BOB, token: TOKEN, tickLower: -600, tickUpper: -60, liquidity: 1n, quoteAmt: 900n * E18 }, stack.trampWallManager!, 82n),
      mk("TrampPlaced", { id: 6n, owner: BOB, token: TOKEN, tickLower: -600, tickUpper: -60, liquidity: 1n, quoteAmt: 400n * E18 }, stack.trampWallManager!, 82n),
      mk("Cancelled", { id: 6n, owner: BOB, token: TOKEN, tickLower: -600, tickUpper: -60, quoteOut: 200n * E18, tokenOut: 150n * E18, quoteFees: 0n, tokenFees: 0n }, stack.trampWallManager!, 83n),
    ], (b) => 1_000_000 + Number(b) * 60);
    return db;
  }
  it("constant mirrors web/lib/config TRAMP_WALL_POINTS_PER_USD = 1", () => {
    expect(TRAMP_WALL_POINTS_PER_USD).toBe(1);
  });
  it("mid-range price: both token orientations", () => {
    expect(midRangePrice(0, 60, true)).toBeCloseTo(1.0001 ** 30, 12);
    expect(midRangePrice(0, 60, false)).toBeCloseTo(1.0001 ** -30, 12);
    expect(midRangePrice(-120, 0, true)).toBeCloseTo(1.0001 ** -60, 12);
    expect(tokenIsCurrency0(TOKEN, QUOTE)).toBe(true);
    expect(tokenIsCurrency0(TOKEN, "0x0000000000000000000000000000000000000000")).toBe(false); // native quote is currency0
    expect(wallUsd(2n * E18, 0, 0, true, 3)).toBe(6);
  });
  it("counters: points = Σ floor(usd × K) over filled rows only (no flat bonus, no fee share)", async () => {
    const api = new Api(withFilledWall(), null, cfg);
    const [, a]: any = await api.route("GET", new URL(`http://x/users/${ALICE}/counters`));
    // filled tramps $1500 + $10, filled wall floor($1094.7…); cancelled wall #3 earns 0
    expect(a).toMatchObject({ trampsFilled: 2, wallsFilled: 1, trampWallPointsPerUsd: 1 });
    expect(a.trampWallPoints).toBe(1500 + 10 + Math.floor(WALL4_USD));
    expect(Math.floor(WALL4_USD)).toBe(1094);
    const [, b]: any = await api.route("GET", new URL(`http://x/users/${BOB}/counters`));
    expect(b).toMatchObject({ trampsPlaced: 2, trampsFilled: 0, trampWallPoints: 0 });
    const board = await api.route("GET", new URL("http://x/leaderboard/tramps"));
    const rows = board[1] as any[];
    expect(rows.find((r) => r.user === ALICE.toLowerCase()).points).toBe(1500 + 10 + 1094);
    expect(rows.find((r) => r.user === BOB.toLowerCase()).points).toBe(0);
  });
  it("recompute: old placement-price wall USD is rewritten to mid-range USD; tramps untouched", () => {
    const db = withFilledWall();
    db.prepare("UPDATE orders SET amount_in_usd = 20 WHERE kind='wall'").run(); // old: tokens × last trade price
    expect(recomputeWallUsd(db)).toBe(2);
    const usd = (id: number) => (db.prepare("SELECT amount_in_usd u FROM orders WHERE id=?").get(id) as any).u;
    expect(usd(3)).toBeCloseTo(5 * 1.0001 ** 30, 9);
    expect(usd(4)).toBeCloseTo(WALL4_USD, 6);
    expect(usd(1)).toBe(1500);
  });
  it("openDb runs the wall-USD recompute once on an existing db file", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "idx-")), "x.sqlite");
    const db = openDb(f);
    applyLogs(db, stack, [
      mk("Launched", { token: TOKEN, curve: CURVE, creator: ALICE, quote: QUOTE, name: "Coin", ticker: "C", creatorTaxBps: 0n }, stack.launchpad),
      mk("QuotePriced", { token: TOKEN, quote: QUOTE, quotePriceUsd: 2n * E18 }, stack.launchpad),
      mk("WallPlaced", { id: 9n, owner: ALICE, token: TOKEN, tickLower: 0, tickUpper: 60, liquidity: 1n, tokenAmt: 10n * E18 }, stack.trampWallManager!, 2n),
    ], (b) => Number(b));
    db.prepare("UPDATE orders SET amount_in_usd = 99 WHERE id = 9").run();
    db.prepare("DELETE FROM meta WHERE k = 'wall_usd_v'").run(); // a db from before this migration
    db.close();
    const db2 = openDb(f);
    expect((db2.prepare("SELECT amount_in_usd u FROM orders WHERE id = 9").get() as any).u).toBeCloseTo(10 * 1.0001 ** 30 * 2, 9);
    expect((db2.prepare("SELECT v FROM meta WHERE k = 'wall_usd_v'").get() as any).v).toBe("1");
    db2.close();
  });
});

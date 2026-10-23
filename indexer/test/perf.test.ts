import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { EVENTS } from "../src/abi";
import { openDb, rebuildCoinStats, wipeStack, dataVersion } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { Api, intParam, CANDLE_MAX_BARS } from "../src/api";
import { tradeUsd } from "../src/usd";
import type { Config, Stack } from "../src/config";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const stack: Stack = { id: "t", fromBlock: 0n, launchpad: A(1), feeRouter: A(2), hook: A(3), migration: A(4), trampWallManager: A(5), anonLauncher: A(6), rewardsVault: A(7) };
const cfg: Config = { chainId: 1, rpcUrl: "", stateView: A(9), stacks: [stack], dbPath: ":memory:", port: 0, chunk: 1000n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 10n };
const T1 = A(0x100), C1 = A(0x101), T2 = A(0x200), C2 = A(0x201), T3 = A(0x300), C3 = A(0x301), QUOTE = A(0x102), ALICE = A(0xa1), BOB = A(0xb0b);
let li = 0;
function mk(name: string, args: Record<string, any>, address: Hex, block = 1n): RawLog {
  const ev: any = EVENTS.find((e: any) => e.name === name)!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any);
  const nonIdx = ev.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i: any) => args[i.name]));
  return { address, topics: topics as any, data, blockNumber: block, transactionHash: `0x${(++li).toString(16).padStart(64, "0")}` as Hex, logIndex: li };
}
const E18 = 10n ** 18n;
// mcapAfterUsd consistent with the price ($/token × 7B supply): the indexer prices from mcap / supply (FLOW #115).
const trade = (token: Hex, src: Hex, trader: Hex, quote: bigint, price: bigint, block: bigint) =>
  mk("Trade", { token, trader, isBuy: true, quoteAmt: quote * E18, tokenAmt: 1n, fee: 0n, snipeFee: 0n, priceBeforeX18: 0n, priceAfterX18: price * E18, impactBps: 0n, mcapAfterUsd: price * 7_000_000_000n * E18 }, src, block);
const ts = (b: bigint) => 1_000_000 + Number(b) * 60;
const bkt = (b: bigint) => Math.floor(ts(b) / 60) * 60;
const launches = () => [
  mk("Launched", { token: T1, curve: C1, creator: ALICE, quote: QUOTE, name: "One", ticker: "ONE", creatorTaxBps: 0n }, stack.launchpad),
  mk("QuotePriced", { token: T1, quote: QUOTE, quotePriceUsd: E18 }, stack.launchpad),
  mk("Launched", { token: T2, curve: C2, creator: BOB, quote: QUOTE, name: "Two", ticker: "TWO", creatorTaxBps: 0n }, stack.launchpad, 2n),
  mk("QuotePriced", { token: T2, quote: QUOTE, quotePriceUsd: 2n * E18 }, stack.launchpad, 2n),
  mk("Launched", { token: T3, curve: C3, creator: BOB, quote: QUOTE, name: "Quiet", ticker: "QQ", creatorTaxBps: 0n }, stack.launchpad, 3n),
];
const tradesBatch = () => [
  trade(T1, C1, BOB, 100n, 2n, 5n), trade(T1, C1, ALICE, 50n, 3n, 5n),   // same block: later log wins
  trade(T2, C2, BOB, 10n, 1n, 6n), trade(T1, stack.hook, BOB, 7n, 4n, 90n), trade(T2, C2, ALICE, 1n, 9n, 7n),
  trade(T1, A(0xbad), BOB, 999n, 1n, 8n),   // spoofed emitter: ignored
];
function seeded() { const db = openDb(":memory:"); applyLogs(db, stack, launches(), ts); applyLogs(db, stack, tradesBatch(), ts); return db; }

/** The pre-aggregate listCoins query, verbatim, as the reference. */
const legacy = (db: any, order: string) => db.prepare(
  `SELECT c.*, COALESCE(SUM(t.volume_usd),0) volume_usd, COUNT(t.id) trades,
    (SELECT CAST(mcap_usd AS REAL)/1e18 FROM trades x WHERE x.token=c.token ORDER BY x.ts DESC, x.block DESC LIMIT 1) last_mcap
   FROM coins c LEFT JOIN trades t ON t.token=c.token GROUP BY c.token ORDER BY ${order} LIMIT 50`).all();
const get = async (api: Api, u: string) => (await api.route("GET", new URL(`http://x${u}`)))[1] as any;

describe("coin_stats aggregates (listCoins)", () => {
  it("same rows/columns as the old join for every sort", async () => {
    const db = seeded(); const api = new Api(db, null, cfg);
    for (const [sort, order] of [["new", "c.launched_block DESC"], ["volume", "volume_usd DESC"], ["mcap", "last_mcap DESC"]]) {
      const now = await get(api, `/coins?sort=${sort}`);
      expect(now).toEqual(legacy(db, order));
    }
    const one = (await get(api, "/coins?sort=volume")).find((c: any) => c.ticker === "ONE");
    expect(one).toMatchObject({ volume_usd: 157, trades: 3, last_mcap: 28_000_000_000 });
    const quiet = (await get(api, "/coins")).find((c: any) => c.ticker === "QQ");
    expect(quiet).toMatchObject({ volume_usd: 0, trades: 0, last_mcap: null });
    expect(Object.keys(one).slice(-3)).toEqual(["volume_usd", "trades", "last_mcap"]);
  });
  it("re-applying the same logs (idempotent re-sync) doesn't double count", () => {
    const db = openDb(":memory:"); applyLogs(db, stack, launches(), ts);
    const b = tradesBatch(); applyLogs(db, stack, b, ts); applyLogs(db, stack, b, ts);
    expect(db.prepare("SELECT trades, volume_usd FROM coin_stats WHERE token=?").get(T1.toLowerCase())).toEqual({ trades: 3, volume_usd: 157 });
  });
  it("incremental == rebuildCoinStats; wipeStack clears them", () => {
    const db = seeded();
    const inc = db.prepare("SELECT * FROM coin_stats ORDER BY token").all();
    rebuildCoinStats(db);
    expect(db.prepare("SELECT * FROM coin_stats ORDER BY token").all()).toEqual(inc);
    wipeStack(db, "t");
    expect((db.prepare("SELECT COUNT(*) n FROM coin_stats").get() as any).n).toBe(0);
  });
  it("migration backfills coin_stats for a DB indexed before the aggregates", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "idx-")), "db.sqlite");
    const db = openDb(f); applyLogs(db, stack, launches(), ts); applyLogs(db, stack, tradesBatch(), ts);
    const want = db.prepare("SELECT * FROM coin_stats ORDER BY token").all();
    db.exec("DROP TABLE coin_stats; DELETE FROM meta;"); db.close();   // old-schema DB
    const db2 = openDb(f);
    expect(db2.prepare("SELECT * FROM coin_stats ORDER BY token").all()).toEqual(want);
    db2.close();
  });
  it("trades(trader, ts) index exists and serves the leaderboard", () => {
    const db = seeded();
    expect((db.prepare("PRAGMA index_info(trades_trader_ts)").all() as any[]).map((c) => c.name)).toEqual(["trader", "ts"]);
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT trader, COUNT(*) FROM trades WHERE ts >= ? GROUP BY trader").all(0) as any[]).map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/trades_trader_ts/);
  });
  it("USD math lives in one function (swap point for #75)", () => {
    // price = mcap / supply (7e10 / 7e9 = $10), never the floored priceAfterX18 (here deliberately inconsistent: 1)
    expect(tradeUsd({ quotePriceUsdWad: (2n * E18).toString(), quoteAmt: 3n * E18, priceAfterX18: 1n, mcapAfterUsd: 70_000_000_000n * E18 }))
      .toEqual({ priceUsd: 10, volumeUsd: 6, mcapUsdWad: (70_000_000_000n * E18).toString() });
    // no mcap source at all ⇒ legacy priceAfterX18 × quote price
    expect(tradeUsd({ quotePriceUsdWad: (2n * E18).toString(), quoteAmt: 3n * E18, priceAfterX18: 5n * E18 }).priceUsd).toBe(10);
  });
});

describe("candles range", () => {
  it("default window ends at the last trade; explicit from/to; span capped; open seeded from the prior close", async () => {
    const api = new Api(seeded(), null, cfg);
    const all = await get(api, `/coins/${T1}/candles?interval=1m`);
    expect(all.map((c: any) => c.t)).toEqual([bkt(5n), bkt(90n)]);
    const tail = await get(api, `/coins/${T1}/candles?interval=1m&from=${ts(10n)}`);
    expect(tail).toEqual([{ t: bkt(90n), o: 3, h: 4, l: 3, c: 4, v: 7, n: 1 }]);   // opens at the close before `from`
    expect(await get(api, `/coins/${T1}/candles?interval=1m&from=${ts(6n)}&to=${ts(80n)}`)).toEqual([]);
    // span cap: from far in the past is raised to to − CANDLE_MAX_BARS × interval
    const capped = await get(api, `/coins/${T1}/candles?interval=1m&from=0&to=${ts(90n) + 1}`);
    expect(capped.length).toBe(2);
    const far = await get(api, `/coins/${T1}/candles?interval=1m&from=0&to=${ts(5n) + CANDLE_MAX_BARS * 60 + 120}`);
    expect(far).toEqual([{ t: bkt(90n), o: 3, h: 4, l: 3, c: 4, v: 7, n: 1 }]);
    expect(await get(api, `/coins/${T3}/candles`)).toEqual([]);
    await expect(api.route("GET", new URL(`http://x/coins/${T1}/candles?from=10&to=5`))).rejects.toThrow(/from must be/);
  });
});

describe("params + list cache", () => {
  it("holders limit: default, clamped, never NaN", async () => {
    const db = openDb(":memory:"); applyLogs(db, stack, launches(), ts);
    applyLogs(db, stack, [1, 2, 3].map((i) => mk("Transfer", { from: A(0), to: A(0x1000 + i), value: BigInt(i) * E18 }, T1, 4n)), ts);
    const api = new Api(db, null, cfg);
    expect((await get(api, `/coins/${T1}/holders`)).length).toBe(3);
    expect((await get(api, `/coins/${T1}/holders?limit=abc`)).length).toBe(3);
    expect((await get(api, `/coins/${T1}/holders?limit=-5`)).length).toBe(1);
    expect((await get(api, `/coins/${T1}/holders?limit=2`)).length).toBe(2);
    const q = (s: string) => new URLSearchParams(s);
    expect(intParam(q("limit=NaN"), "limit", 100, 1, 1000)).toBe(100);
    expect(intParam(q("limit=99999"), "limit", 100, 1, 1000)).toBe(1000);
    expect(intParam(q(""), "limit", 100, 1, 1000)).toBe(100);
    expect((await get(api, "/coins?limit=zzz")).length).toBe(3);
  });
  it("list responses are cached briefly but never outlive new ingest", async () => {
    const db = seeded(); const api = new Api(db, null, cfg);
    const a = await get(api, "/coins?sort=volume"), b = await get(api, "/coins?sort=volume");
    expect(b).toBe(a);   // same cached object
    const v = dataVersion(db);
    applyLogs(db, stack, [trade(T2, C2, BOB, 1000n, 1n, 200n)], ts);
    expect(dataVersion(db)).toBe(v + 1);
    const c = await get(api, "/coins?sort=volume");
    expect(c).not.toBe(a); expect(c[0].ticker).toBe("TWO");
  });
  it("Cache-Control s-maxage on list endpoints only", async () => {
    const api = new Api(seeded(), null, cfg);
    const srv = api.server(); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    try {
      const l = await fetch(`http://127.0.0.1:${port}/coins`); expect(l.headers.get("cache-control")).toMatch(/s-maxage=5/);
      const lb = await fetch(`http://127.0.0.1:${port}/leaderboard/traders`); expect(lb.headers.get("cache-control")).toMatch(/s-maxage/);
      const d = await fetch(`http://127.0.0.1:${port}/coins/${T1}/trades`); expect(d.headers.get("cache-control")).toBeNull();
    } finally { srv.close(); }
  });
});

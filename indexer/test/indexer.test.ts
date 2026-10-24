import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { EVENTS } from "../src/abi";
import { openDb } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { Api } from "../src/api";
import { candles, mcapUsdFromSqrt, mcapUsdWad, priceWadFromSqrt, virtualQuoteReserve } from "../src/math";
import type { Config, Stack } from "../src/config";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const stack: Stack = { id: "t", fromBlock: 0n, launchpad: A(1), feeRouter: A(2), hook: A(3), migration: A(4), trampWallManager: A(5), anonLauncher: A(6), rewardsVault: A(7), lockedLP: A(8) };
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
    expect(mcapUsdWad(10n ** 18n, 10n ** 18n)).toBe(1_000_000n * 10n ** 18n);
    expect(virtualQuoteReserve(1000n, Q96, true)).toBe(1000n);
  });
  it("TRMP-like pool price ~ $45.3K", () => {
    // live TRMP slot0 (token is currency1) and STRATEGY = $0.00245 — legacy 7B-supply coin, supply passed explicitly
    const p = priceWadFromSqrt(1541825069166933097153735021859n, false);
    const m = Number(mcapUsdWad(p, 2450000000000000n, 7_000_000_000n * 10n ** 18n)) / 1e18;
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
    expect(o.find((x: any) => x.id === 3).amount_in_usd).toBe(20); // 5 tokens × last price $4
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

describe("lp auto-compound", () => {
  it("indexes LiquidityCompounded from LockedLP only and serves /lp-compounds", async () => {
    const db = seeded();
    const ts = (b: bigint) => 1_000_000 + Number(b) * 60;
    applyLogs(db, stack, [
      mk("LiquidityCompounded", { token: TOKEN, liquidity: 1000n, tokenUsed: 50n, quoteUsed: 7n, tokenCarry: 1n, quoteCarry: 3n }, stack.lockedLP!, 80n),
      mk("LiquidityCompounded", { token: TOKEN, liquidity: 500n, tokenUsed: 20n, quoteUsed: 4n, tokenCarry: 9n, quoteCarry: 1n }, stack.lockedLP!, 81n),
      mk("LiquidityCompounded", { token: TOKEN, liquidity: 999n, tokenUsed: 1n, quoteUsed: 1n, tokenCarry: 0n, quoteCarry: 0n }, A(0xbad), 82n), // spoof
    ], ts);
    const api = new Api(db, null, cfg);
    const [st, r]: any = await api.route("GET", new URL(`http://x/coins/${TOKEN}/lp-compounds`));
    expect(st).toBe(200);
    expect(r).toMatchObject({ count: 2, totalLiquidity: "1500", totalTokenUsed: "70", totalQuoteUsed: "11", tokenCarry: "9", quoteCarry: "1" });
  });
});

describe("mcap precision", () => {
  const sqrt = (x: bigint) => { let z = x, y = (x + 1n) / 2n; while (y < z) { z = y; y = (x / y + y) / 2n; } return z; };
  // $33K over 1M tokens; quote raw per token raw = 33000*10^dec / 1e24
  const sqrtFor = (dec: bigint, c0: boolean) => {
    const num = 33_000n * 10n ** dec, den = 1_000_000n * 10n ** 18n;
    return c0 ? sqrt((num << 192n) / den) : sqrt((den << 192n) / num);
  };
  const near = (a: bigint, b: bigint) => expect(Number(a) / Number(b)).toBeCloseTo(1, 4);
  it("6-dec quote: $33K exact from sqrt (1M supply: priceWad path now within 0.01%; 7B floored it to ~$28K)", () => {
    for (const c0 of [true, false]) {
      const sp = sqrtFor(6n, c0);
      near(mcapUsdFromSqrt(sp, c0, 10n ** 30n), 33_000n * 10n ** 18n);
      const viaPrice = Number(mcapUsdWad(priceWadFromSqrt(sp, c0), 10n ** 30n)) / 33_000e18;
      expect(Math.abs(viaPrice - 1)).toBeLessThan(1e-4);
    }
  });
  it("18-dec quote: unchanged", () => {
    for (const c0 of [true, false]) {
      const sp = sqrtFor(18n, c0);
      near(mcapUsdFromSqrt(sp, c0, 10n ** 18n), 33_000n * 10n ** 18n);
      near(mcapUsdFromSqrt(sp, c0, 10n ** 18n), mcapUsdWad(priceWadFromSqrt(sp, c0), 10n ** 18n));
    }
  });
});

describe("#103 creator First BOOST attribution", () => {
  it("credits a private launch's First BOOST to the buyRecipient (smart account), not the AnonLauncher", () => {
    const db = openDb(":memory:");
    const ts = (b: bigint) => 1_000_000 + Number(b) * 60;
    const ANON = stack.anonLauncher!, SMART = A(0x5a), TOK2 = A(0x200), CURVE2 = A(0x201);
    const tx = `0x${"77".repeat(32)}` as Hex;
    const same = (l: RawLog) => ({ ...l, transactionHash: tx });
    applyLogs(db, stack, [
      mk("Launched", { token: TOK2, curve: CURVE2, creator: ANON, quote: QUOTE, name: "Priv", ticker: "P", creatorTaxBps: 0n }, stack.launchpad),
      mk("QuotePriced", { token: TOK2, quote: QUOTE, quotePriceUsd: 10n ** 18n }, stack.launchpad),
    ], ts);
    const t = (trader: Hex) => mk("Trade", { token: TOK2, trader, isBuy: true, quoteAmt: 5n * 10n ** 18n, tokenAmt: 9n, fee: 0n, snipeFee: 0n, priceBeforeX18: 0n, priceAfterX18: 10n ** 18n, impactBps: 0n, mcapAfterUsd: 33_000n * 10n ** 18n }, CURVE2, 2n);
    applyLogs(db, stack, [
      same(mk("Transfer", { from: A(0), to: CURVE2, value: 7n * 10n ** 27n }, TOK2, 2n)),
      same(t(ANON)),
      same(mk("Transfer", { from: CURVE2, to: ANON, value: 9n }, TOK2, 2n)),
      same(mk("Transfer", { from: ANON, to: SMART, value: 9n }, TOK2, 2n)),
      t(BOB), // an unrelated buy in another tx is untouched
    ], ts);
    const rows = db.prepare("SELECT trader, tx FROM trades WHERE token=? ORDER BY trader").all(TOK2.toLowerCase()) as any[];
    expect(rows.map((r) => r.trader).sort()).toEqual([BOB.toLowerCase(), SMART.toLowerCase()].sort());
    expect(rows.find((r) => r.trader === SMART.toLowerCase())!.tx).toBe(tx);
    const bal = db.prepare("SELECT bal FROM balances WHERE token=? AND holder=?").get(TOK2.toLowerCase(), SMART.toLowerCase()) as any;
    expect(bal.bal).toBe("9");
  });
});

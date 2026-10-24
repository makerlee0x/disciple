// SITE #137: after our own fill, balances / position / feed are booked from the fill's receipt logs (lib/fillBook), and
// any unavoidable re-read is pinned at/after the receipt block — a lagging public-RPC node never puts the pre-fill
// value back.  pnpm test:fill-book
import { test } from "node:test";
import assert from "node:assert/strict";
import { FillBook, TRANSFER_TOPIC, blockOf, blockOfLogs, bookFill, readAtOrAfter, rawUnits, transferDeltas } from "../lib/fillBook";
import { bookedPortfolio, summarize } from "../lib/portfolio";
import { pollUntilFill, readMcapAt, usdgFromReceipt } from "../lib/events";
import { encodeAbiParameters, encodeEventTopics, pad } from "viem";
import { discipleRouterAbi } from "../lib/abi";

const ME = "0x00000000000000000000000000000000000000aa", POOL = "0x00000000000000000000000000000000000000bb";
const COIN = "0x00000000000000000000000000000000000000c0", USDG = "0x00000000000000000000000000000000000000d0";
const tlog = (token: string, from: string, to: string, v: bigint, blockNumber: unknown = "0x64") =>
  ({ address: token, topics: [TRANSFER_TOPIC, pad(from as `0x${string}`), pad(to as `0x${string}`)], data: pad(`0x${v.toString(16)}`), blockNumber }) as never;
const clock = (t0 = 1000) => { let t = t0; return { now: () => t, adv: (ms: number) => { t += ms; } }; };

test("blockOf / blockOfLogs parse hex, decimal, bigint; reject junk", () => {
  assert.equal(blockOf("0x64"), BigInt(100)); assert.equal(blockOf("100"), BigInt(100)); assert.equal(blockOf(BigInt(7)), BigInt(7)); assert.equal(blockOf(7.9), BigInt(7));
  assert.equal(blockOf("zz"), undefined); assert.equal(blockOf(null), undefined); assert.equal(blockOf(-1), undefined);
  assert.equal(blockOfLogs([{}, { blockNumber: "0x10" }]), BigInt(16)); assert.equal(blockOfLogs(undefined), undefined);
});

test("transferDeltas: exact in − out per token for the holder only", () => {
  const d = transferDeltas([
    tlog(USDG, ME, POOL, BigInt(25_000_000)), tlog(USDG, POOL, ME, BigInt(1_000_000)),   // pay 25, refund 1
    tlog(COIN, POOL, ME, BigInt(10) ** BigInt(21)),
    tlog(COIN, POOL, "0x00000000000000000000000000000000000000ee", BigInt(5)),             // someone else
    { address: COIN, topics: ["0xdead"], data: "0x" } as never,
  ], ME);
  assert.equal(d.get(USDG), BigInt(-24_000_000)); assert.equal(d.get(COIN), BigInt(10) ** BigInt(21)); assert.equal(d.size, 2);
  assert.equal(rawUnits(BigInt(-24_000_000), 6), -24); assert.equal(rawUnits(BigInt(15) * BigInt(10) ** BigInt(17), 18), 1.5);
});

test("buy booked from the receipt; a stale read below the receipt block never shows the old lower balance", () => {
  const c = clock(), b = new FillBook(c.now);
  b.observe(ME, COIN, 100, BigInt(90));
  assert.ok(b.book(ME, COIN, "0xt1", 50, BigInt(100)));
  assert.equal(b.display(ME, COIN), 150);                       // shown right away, no RPC
  assert.equal(b.observe(ME, COIN, 100, BigInt(99)), 150);       // lagging node (block 99): booked value kept
  assert.equal(b.observe(ME, COIN, 100, BigInt(80)), 150);       // older than the last read: ignored
  assert.equal(b.observe(ME, COIN, 150, BigInt(100)), 150);      // node caught up: read includes the fill
  assert.deepEqual(b.pendingTokens(ME), []);
  assert.equal(b.observe(ME, COIN, 149, BigInt(101)), 149);      // later reads are the truth again
});

test("sell: stale read keeps the booked lower balance; no double count when the read already includes it", () => {
  const c = clock(), b = new FillBook(c.now);
  b.observe(ME, COIN, 100, BigInt(90));
  b.book(ME, COIN, "0xs", -40, BigInt(100));
  assert.equal(b.observe(ME, COIN, 100, BigInt(95)), 60);
  assert.equal(b.observe(ME, COIN, 60, BigInt(100)), 60);
  // race: a read at ≥ the receipt block landed BEFORE the fill was booked ⇒ booking adds nothing
  const b2 = new FillBook(c.now);
  b2.observe(ME, COIN, 60, BigInt(101));
  assert.equal(b2.book(ME, COIN, "0xs", -40, BigInt(100)), false);
  assert.equal(b2.display(ME, COIN), 60);
});

test("idempotent per tx; multiple fills stack; each retires at its own block", () => {
  const c = clock(), b = new FillBook(c.now);
  b.observe(ME, COIN, 0, BigInt(90));
  assert.ok(b.book(ME, COIN, "0xa", 10, BigInt(100)));
  assert.equal(b.book(ME, COIN, "0xA", 10, BigInt(100)), false);   // same tx (case-insensitive)
  assert.ok(b.book(ME, COIN, "0xb", 5, BigInt(102)));
  assert.equal(b.display(ME, COIN), 15);
  assert.equal(b.observe(ME, COIN, 10, BigInt(101)), 15);          // includes a, not b
  assert.equal(b.observe(ME, COIN, 15, BigInt(102)), 15);
  assert.deepEqual(b.pendingTokens(ME), []);
});

test("read without a block: pre-fill side held within the TTL, accepted once it shows the fill or after the TTL", () => {
  const c = clock(), b = new FillBook(c.now, 20_000);
  b.observe(ME, COIN, 100);
  c.adv(10); b.book(ME, COIN, "0xt", 50);
  c.adv(10);
  assert.equal(b.observe(ME, COIN, 100), 150);                     // started after booking but still pre-fill
  assert.equal(b.observe(ME, COIN, 151), 151);                     // shows the fill (and more): accepted
  b.book(ME, COIN, "0xu", 10);
  c.adv(20_001);
  assert.equal(b.observe(ME, COIN, 151), 151);                     // TTL: unplaceable entries expire
});

test("floor: per holder + any own op, expires with the TTL", () => {
  const c = clock(), b = new FillBook(c.now, 1000);
  assert.equal(b.floor(ME), undefined);
  b.raiseFloor(ME, BigInt(100)); b.raiseFloor(ME, BigInt(90));
  assert.equal(b.floor(ME), BigInt(100));
  b.raiseFloor("*", BigInt(105));
  assert.equal(b.floor(ME), BigInt(105)); assert.equal(b.floor(POOL), BigInt(105));
  c.adv(1001);
  assert.equal(b.floor(ME), undefined);
});

test("bookFill: usdg-sourced fill books coin + USDG; quote-valued fill books only the coin; other trader skipped", () => {
  const c = clock(), b = new FillBook(c.now);
  const ctx = { holder: ME, coin: COIN, usdg: USDG, usdgDecimals: 6, coinDecimals: 18, block: BigInt(100) };
  b.observe(ME, COIN, 0, BigInt(99)); b.observe(ME, USDG, 1000, BigInt(99));
  assert.deepEqual(bookFill(b, { txHash: "0x1", side: "buy", usd: 25, tokens: 1e6, source: "usdg" }, ctx).sort(), [COIN, USDG].sort());
  assert.equal(b.display(ME, COIN), 1e6); assert.equal(b.display(ME, USDG), 975);
  assert.deepEqual(bookFill(b, { txHash: "0x2", side: "sell", usd: 10, tokens: 4e5, source: "curve" }, ctx), [COIN]);
  assert.equal(b.display(ME, USDG), 975);                          // $ is a quote estimate: not booked as cash
  assert.equal(b.floor(ME), BigInt(100));
  assert.deepEqual(bookFill(b, { txHash: "0x3", side: "buy", usd: 5, tokens: 1, source: "usdg", trader: POOL }, ctx), []);
  assert.deepEqual(bookFill(b, { txHash: "0x4" }, ctx), []);       // nothing decoded ⇒ nothing booked (no optimistic fill)
});

test("bookFill: receipt logs ⇒ exact Transfer deltas at the logs' block", () => {
  const c = clock(), b = new FillBook(c.now);
  b.observe(ME, USDG, 100, BigInt(98)); b.observe(ME, COIN, 0, BigInt(98));
  const logs = [tlog(USDG, ME, POOL, BigInt(25_000_000), "0x65"), tlog(USDG, POOL, ME, BigInt(500_000), "0x65"), tlog(COIN, POOL, ME, BigInt(3) * BigInt(10) ** BigInt(18), "0x65")];
  const done = bookFill(b, { txHash: "0x9", side: "buy", usd: 999, tokens: 999, logs }, { holder: ME, coin: COIN, usdg: USDG, usdgDecimals: 6 });
  assert.deepEqual(done.sort(), [COIN, USDG].sort());
  assert.equal(b.display(ME, USDG), 75.5); assert.equal(b.display(ME, COIN), 3);
  assert.equal(b.floor(ME), BigInt(101));
  assert.equal(b.observe(ME, USDG, 100, BigInt(100)), 75.5);       // one block behind: still booked
});

test("bookedPortfolio: cash + holdings from the book; first buy priced at our fill until a read prices it", () => {
  const c = clock(), b = new FillBook(c.now);
  const pf = summarize(100, [{ coin: COIN as never, tokens: 10, priceNow: 2, price24h: 2 }], 1);
  b.observe(ME, USDG, 100, BigInt(90)); b.observe(ME, COIN, 10, BigInt(90));
  const NEW = "0x00000000000000000000000000000000000000c1";
  b.book(ME, USDG, "0xn", -20, BigInt(100)); b.book(ME, NEW, "0xn", 4, BigInt(100)); b.observe(ME, NEW, 0, BigInt(99));
  const out = bookedPortfolio(pf, ME, USDG, new Map([[NEW, 5]]), b);
  assert.equal(out.cashUsd, 80); assert.equal(out.holdingsUsd, 10 * 2 + 4 * 5); assert.equal(out.holdings.length, 2);
});

test("readAtOrAfter: pins to the receipt block; retries while the node is behind; then latest-or-later", async () => {
  let head = BigInt(98), calls = 0;
  const pc = { getBlockNumber: async () => head };
  const seen: bigint[] = [];
  const r = await readAtOrAfter(pc, BigInt(100), async (bn) => { seen.push(bn); if (++calls < 3) throw new Error("header not found"); head = BigInt(103); return 7; }, { delayMs: 1 });
  assert.equal(r.value, 7); assert.equal(r.block, BigInt(100)); assert.deepEqual(seen, [BigInt(100), BigInt(100), BigInt(100)]);
  head = BigInt(120);
  assert.equal((await readAtOrAfter(pc, BigInt(100), async (bn) => bn)).block, BigInt(120));
  assert.equal((await readAtOrAfter(pc, undefined, async (bn) => bn)).block, BigInt(120));
  await assert.rejects(readAtOrAfter(pc, BigInt(1), async () => { throw new Error("down"); }, { tries: 2, delayMs: 1 }), /down/);
});

test("pollUntilFill: keeps polling until the getLogs node has the receipt block and the tx's row arrived", async () => {
  let head = BigInt(97), has = false, ticks = 0;
  const p = { tick: async () => { ticks++; head += BigInt(1); if (head >= BigInt(100)) has = true; }, head: () => head, has: (tx: string) => has && tx === "0xf" };
  assert.equal(await pollUntilFill([p], BigInt(100), "0xf", { sleep: async () => {} }), true);
  assert.equal(ticks, 3);
  // a tx that isn't this coin's trade: stops a few polls after the node passed the block
  let t2 = 0; const q = { tick: async () => { t2++; }, head: () => BigInt(200), has: () => false };
  assert.equal(await pollUntilFill([q], BigInt(100), "0xother", { sleep: async () => {} }), false);
  assert.equal(t2, 3);
  // no block known: the old two polls (now + 700 ms)
  let t3 = 0; const slept: number[] = [];
  await pollUntilFill([{ tick: async () => { t3++; }, head: () => BigInt(0), has: () => false }], undefined, "0xf", { sleep: async (ms) => { slept.push(ms); } });
  assert.equal(t3, 2); assert.deepEqual(slept, [700]);
});

test("usdgFromReceipt: the router's UsdgTrade from the tx receipt; retries a node that has no receipt yet; caches", async () => {
  const ROUTER = "0x00000000000000000000000000000000000000f0";
  const ev = discipleRouterAbi.find((x) => x.type === "event" && x.name === "UsdgTrade") as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const args: Record<string, unknown> = {};
  for (const i of ev.inputs) args[i.name] = i.type === "address" ? (i.name === "token" ? COIN : ME) : i.type === "bool" ? true : BigInt(25_000_000);
  const topics = encodeEventTopics({ abi: discipleRouterAbi, eventName: "UsdgTrade", args: args as never });
  const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed) as never, ev.inputs.filter((i) => !i.indexed).map((i) => args[i.name]) as never);
  let calls = 0;
  const pc = { getTransactionReceipt: async () => { if (++calls < 3) throw new Error("TransactionReceiptNotFoundError"); return { logs: [{ address: POOL, topics: [], data: "0x" }, { address: ROUTER, topics, data }] }; } } as never;
  const u = await usdgFromReceipt(pc, ROUTER as never, "0xabc", COIN, true, ME, { delayMs: 1 });
  assert.ok(u); assert.equal(String(u!.token).toLowerCase(), COIN);
  assert.equal(calls, 3);
  await usdgFromReceipt(pc, ROUTER as never, "0xabc", COIN, true, ME, { delayMs: 1 });
  assert.equal(calls, 3);                                           // definitive answer cached
  assert.equal(await usdgFromReceipt(pc, ROUTER as never, "0xabc", COIN, false, ME, { delayMs: 1 }), undefined);   // other side
  const none = { getTransactionReceipt: async () => { throw new Error("not found"); } } as never;
  assert.equal(await usdgFromReceipt(none, ROUTER as never, "0xdef", COIN, true, ME, { tries: 2, delayMs: 1 }), undefined);
});

test("readMcapAt: a node without the block yields null (tick skipped), never a mislabeled latest value", async () => {
  const pc = { readContract: async () => { throw new Error("header not found"); } } as never;
  assert.equal(await readMcapAt(pc, COIN as never, BigInt(100), { tries: 2, delayMs: 1 }), null);
});

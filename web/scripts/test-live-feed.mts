// Live trade feed vs a lagging, filter-less RPC (RH testnet): pollLogs must not lose a trade a lagging node didn't have yet,
// must stream from fromBlock (no gap after the state read), and must never emit a log twice.  pnpm test:live-feed
import { test } from "node:test";
import assert from "node:assert/strict";
import { pollLogs } from "../lib/events";

type Lg = { transactionHash: string; logIndex: number; blockNumber: bigint; eventName: string; args: Record<string, unknown> };
const lg = (b: number, i = 0): Lg => ({ transactionHash: `0x${b.toString(16)}`, logIndex: i, blockNumber: BigInt(b), eventName: "Trade", args: {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("trade missed by a lagging getLogs node is picked up by the rescan, once", async () => {
  const chain: Lg[] = [lg(101), lg(105)];
  let head = 110, lagNext = true;
  const pc = { getBlockNumber: async () => BigInt(head) } as never;
  const got: string[] = [];
  const p = pollLogs({
    pc, fromBlock: BigInt(101), everyMs: 20,
    // the first getLogs hits a node 6 blocks behind: it has nothing past 104 and answers without error
    fetch: async (from, to) => { const top = lagNext ? Number(to) - 6 : Number(to); lagNext = false; return chain.filter((l) => l.blockNumber >= from && Number(l.blockNumber) <= top) as never; },
    onLogs: (ls) => ls.forEach((l) => got.push(`${l.blockNumber}`)),
  });
  await sleep(120);
  head = 112; chain.push(lg(111, 0), lg(111, 1));
  await sleep(120);
  p.stop();
  assert.deepEqual(got, ["101", "105", "111", "111"]);
});

test("streams from fromBlock, chain-ordered within a batch", async () => {
  const chain = [lg(52, 3), lg(50, 1), lg(52, 1), lg(49)];
  const pc = { getBlockNumber: async () => BigInt(60) } as never;
  const got: string[] = [];
  const p = pollLogs({ pc, fromBlock: BigInt(50), everyMs: 1000, fetch: async (f, t) => chain.filter((l) => l.blockNumber >= f && l.blockNumber <= t) as never, onLogs: (ls) => ls.forEach((l) => got.push(`${l.blockNumber}:${l.logIndex}`)) });
  await sleep(50); p.kick(); await sleep(50); p.stop();
  assert.deepEqual(got, ["50:1", "52:1", "52:3"]);
});

test("RPC errors don't advance or crash; stop() halts", async () => {
  let fail = true, calls = 0;
  const pc = { getBlockNumber: async () => BigInt(10) } as never;
  const got: number[] = [];
  const p = pollLogs({ pc, fromBlock: BigInt(5), everyMs: 15, fetch: async () => { calls++; if (fail) throw new Error("503"); return [lg(7)] as never; }, onLogs: (ls) => ls.forEach(() => got.push(1)) });
  await sleep(40); fail = false; await sleep(60); p.stop(); const c = calls; await sleep(60);
  assert.equal(got.length, 1); assert.equal(calls, c);
});

test("mcapOrderer passes each tx:logIndex to the engine once", async () => {
  const { mcapOrderer } = await import("../lib/events");
  const out: string[] = [];
  const o = mcapOrderer((e) => out.push(`${(e as { txHash?: string }).txHash}:${(e as { logIndex?: number }).logIndex}`));
  const t = (h: string, i: number, b: number) => ({ type: "Trade", txHash: h, logIndex: i, block: BigInt(b), mcapUsd: 7000 + b }) as never;
  o.trade(t("0xAB", 10, 1)); o.trade(t("0xab", 10, 1)); o.trade(t("0xab", 11, 1)); o.trade(t("0xcd", 10, 2)); o.trade(t("0xAB", 10, 1));
  assert.deepEqual(out, ["0xAB:10", "0xab:11", "0xcd:10"]);
});

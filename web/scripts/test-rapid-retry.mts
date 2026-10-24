// Rapid taps: the transient-error retry re-quotes via SendOpts.rebuild (fresh minOut) with a fresh 2D nonce key; the
// fee-floor retry keeps the calls. Pure: fake aa-sdk client + stubbed fetch, no network.   pnpm test:rapid-retry
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { retryCalls, callsKind } from "../lib/aa/fastPath";
import { Mav2Account, FEES } from "../lib/aa/mav2";
import type { Call } from "../lib/aa/core";

const CURVE = "0x00000000000000000000000000000000000000c1" as Address, TOKEN = "0x00000000000000000000000000000000000000a1" as Address;
const SENDER = "0x00000000000000000000000000000000000000ee" as Address;
const approve = { to: TOKEN, data: "0x095ea7b3" + "00".repeat(64) as Hex };
const buy = (minOut: number): Call => ({ to: CURVE, data: ("0xd96a094a" + minOut.toString(16).padStart(64, "0")) as Hex });
const CALLS = [approve, buy(100)];

test("retryCalls: no rebuild ⇒ original; rebuild ⇒ fresh calls; shape change / throw ⇒ original", async () => {
  assert.equal(await retryCalls(CALLS), CALLS);
  assert.deepEqual(await retryCalls(CALLS, { rebuild: async () => [approve, buy(90)] }), [approve, buy(90)]);
  assert.equal(await retryCalls(CALLS, { rebuild: async () => [buy(90)] }), CALLS);
  assert.equal(await retryCalls(CALLS, { rebuild: async () => [approve, { to: TOKEN, data: buy(90).data }] }), CALLS);
  assert.equal(await retryCalls(CALLS, { rebuild: async () => { throw new Error("rpc down"); } }), CALLS);
  assert.equal(callsKind([approve, buy(1)]), callsKind([approve, buy(2)]), "minOut doesn't change the shape");
});

type Sent = { calls: Hex[]; nonce: bigint };
function fakeAccount(opts: { deployed: boolean }) {
  const sent: Sent[] = [];
  const chain = { id: 999_001, name: "t", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } };
  const pc = { getBalance: async () => BigInt(0) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = new Mav2Account({ chain: chain as any, pc: pc as any, bundlerUrl: "http://bundler.test/api/bundler" }, { address: SENDER } as any);
  a.deployed = opts.deployed;
  const datas = (uo: { data: Hex } | { data: Hex }[]) => (Array.isArray(uo) ? uo : [uo]).map((x) => x.data);
  const client = {
    account: { address: SENDER },
    request: async () => "0x1",
    estimateFeesPerGas: async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }),
    buildUserOperation: async ({ uo, overrides }: { uo: { data: Hex }; overrides: { nonce: bigint } }) => { sent.push({ calls: datas(uo), nonce: overrides.nonce }); return { sender: SENDER, nonce: overrides.nonce, callData: "0x" }; },
    signUserOperation: async ({ uoStruct }: { uoStruct: object }) => ({ ...uoStruct, signature: "0x01" }),
    sendUserOperation: async ({ uo, overrides }: { uo: { data: Hex }; overrides: { nonce: bigint } }) => {
      sent.push({ calls: datas(uo), nonce: overrides.nonce });
      if (sent.length === 1) throw new Error("simulation failed: ERC20InsufficientBalance (lagging node)");
      return { hash: ("0x" + "11".repeat(32)) as Hex, request: {} };
    },
    waitForUserOperationTransaction: async () => ("0x" + "22".repeat(32)) as Hex,
    getUserOperationReceipt: async () => ({ success: true, receipt: { transactionHash: ("0x" + "22".repeat(32)) as Hex, logs: [] } }),
  };
  (a as unknown as { owned: () => Promise<unknown> }).owned = async () => client;
  return { a, sent };
}

test("standard path: TRANSIENT_SIM ⇒ ONE retry with the REBUILT calls and a fresh nonce key", async () => {
  const { a, sent } = fakeAccount({ deployed: false });
  let rebuilds = 0;
  const r = await a.sendCalls(CALLS, "owner", true, { rebuild: async () => { rebuilds++; return [approve, buy(77)]; } });
  assert.equal(rebuilds, 1); assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].calls, CALLS.map((c) => c.data)); assert.deepEqual(sent[1].calls, [approve.data, buy(77).data]);
  assert.notEqual(sent[0].nonce, sent[1].nonce); assert.equal(r.txHash, "0x" + "22".repeat(32));
});

test("standard path without rebuild: retries the same calls (today's behaviour), fresh nonce key", async () => {
  const { a, sent } = fakeAccount({ deployed: false });
  await a.sendCalls(CALLS, "owner");
  assert.deepEqual(sent[1].calls, sent[0].calls); assert.notEqual(sent[0].nonce, sent[1].nonce);
});

const CONF = { kind: "confirmed", userOpHash: "0x" + "33".repeat(32), txHash: "0x" + "44".repeat(32), success: true, logs: [], receipt: { transactionHash: "0x" + "44".repeat(32), blockHash: "0x", blockNumber: "0x1", status: "0x1", gasUsed: "0x1", logs: [] }, via: "sync", t: {} };
function stubRelay(first: { code: number; message: string; data?: string }) {
  const orig = globalThis.fetch; let n = 0;
  globalThis.fetch = (async () => (n++ === 0 ? Response.json({ jsonrpc: "2.0", id: 1, error: first }) : Response.json({ jsonrpc: "2.0", id: 1, result: CONF }))) as typeof fetch;
  return { restore: () => { globalThis.fetch = orig; }, posts: () => n };
}

test("fast path (sync relay): TRANSIENT_SIM pre-flight ⇒ rebuild + fresh nonce key; fee floor ⇒ same calls, no rebuild", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  {
    const { a, sent } = fakeAccount({ deployed: true });
    const s = stubRelay({ code: -32500, message: "AA23 reverted: SessionInactive" });
    let rebuilds = 0;
    try { await a.sendCalls(CALLS, "owner", true, { rebuild: async () => { rebuilds++; return [approve, buy(55)]; } }); } finally { s.restore(); }
    assert.equal(rebuilds, 1); assert.equal(s.posts(), 2);
    assert.deepEqual(sent[1].calls, [approve.data, buy(55).data]); assert.notEqual(sent[0].nonce, sent[1].nonce);
  }
  {
    const { a, sent } = fakeAccount({ deployed: true });
    const s = stubRelay({ code: -32000, message: "fee below relayer floor" });
    let rebuilds = 0;
    try { await a.sendCalls(CALLS, "owner", true, { rebuild: async () => { rebuilds++; return [approve, buy(55)]; } }); } finally { s.restore(); }
    assert.equal(rebuilds, 0); assert.deepEqual(sent[1].calls, sent[0].calls); assert.notEqual(sent[0].nonce, sent[1].nonce);
  }
});

// ---- spec item 10 (server): retries of the same press don't count toward the per-sender limit ----
import { hitSenderSend, bundlerSendPerSender, memoryCounter, BUNDLER_LIMITS } from "../lib/server/limits";
import { newPressId } from "../lib/aa/fastPath";

test("hitSenderSend: first send of a press counts, its next 2 retries don't, the 4th does; no/bad pressId always counts", async () => {
  const lim = { limit: 2, windowSec: 60, pressFreeRetries: 2 }, sender = `0x${"ab".repeat(20)}-${Date.now()}`, press = newPressId();
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await hitSenderSend(memoryCounter, sender, press, lim));
  assert.deepEqual(r.map((x) => x.ok), [true, true, true, true]);
  assert.deepEqual(r.map((x) => x.count), [1, 0, 0, 2], "4th attempt of the same press counts");
  assert.equal((await hitSenderSend(memoryCounter, sender, "not-a-press", lim)).ok, false, "malformed id counts ⇒ over the limit");
  assert.equal((await hitSenderSend(memoryCounter, sender, undefined, lim)).ok, false);
});

test("bundlerSendPerSender: default unchanged (60/60 s, 2 free retries); env override validated", () => {
  assert.deepEqual(bundlerSendPerSender({}), { limit: BUNDLER_LIMITS.sendPerSender.limit, windowSec: 60, pressFreeRetries: 2 });
  assert.equal(BUNDLER_LIMITS.sendPerSender.limit, 60);
  assert.equal(bundlerSendPerSender({ BUNDLER_SEND_PER_SENDER: "120" }).limit, 120);
  assert.equal(bundlerSendPerSender({ BUNDLER_SEND_PER_SENDER: "-1" }).limit, 60);
  assert.equal(bundlerSendPerSender({ BUNDLER_PRESS_FREE_RETRIES: "0" }).pressFreeRetries, 0);
  assert.equal(bundlerSendPerSender({ BUNDLER_PRESS_FREE_RETRIES: "x" }).pressFreeRetries, 2);
});

test("SITE shape sendCalls(calls, { rebuild }) + the retry carries the SAME pressId to the relay", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  const { a, sent } = fakeAccount({ deployed: true });
  const orig = globalThis.fetch, bodies: { params: unknown[] }[] = [];
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32500, message: "AA23 reverted" } }) : Response.json({ jsonrpc: "2.0", id: 1, result: CONF }); }) as unknown as typeof fetch;
  try { await a.sendCalls(CALLS, { rebuild: async () => [approve, buy(9)] }); } finally { globalThis.fetch = orig; }
  assert.deepEqual(sent[1].calls, [approve.data, buy(9).data]);
  const ids = bodies.map((b) => (b.params[2] as { pressId: string }).pressId);
  assert.equal(ids.length, 2); assert.match(ids[0], /^[0-9a-f]{24}$/); assert.equal(ids[0], ids[1]);
});

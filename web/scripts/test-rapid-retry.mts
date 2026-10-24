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
    buildUserOperation: async ({ uo, overrides }: { uo: { data: Hex }; overrides: { nonce: bigint } }) => { sent.push({ calls: datas(uo), nonce: overrides.nonce }); return { sender: SENDER, callData: "0x", ...overrides }; },   // full fields ⇒ userOpHash computable
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
import { hitSenderSend, notePressRejected, rejectedBeforeSend, bundlerSendPerSender, memoryCounter, BUNDLER_LIMITS } from "../lib/server/limits";
import { newPressId } from "../lib/aa/fastPath";

test("L1 hitSenderSend: WITHOUT a server pre-send rejection every send of a press counts (fresh ids buy nothing)", async () => {
  const lim = { limit: 2, windowSec: 60, pressFreeRetries: 2 }, sender = `0x${"ab".repeat(20)}-${Date.now()}`;
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await hitSenderSend(memoryCounter, sender, newPressId(), lim));   // fresh id each time
  assert.deepEqual(r.map((x) => x.ok), [true, true, false, false], "limit 2 holds against fresh press ids");
  const s2 = `${sender}-same`, p = newPressId(), r2 = [];
  for (let i = 0; i < 3; i++) r2.push(await hitSenderSend(memoryCounter, s2, p, lim));                  // same id, never rejected
  assert.deepEqual(r2.map((x) => x.count), [1, 2, 3]);
});

test("L1 hitSenderSend: a pre-send rejection grants ONE free retry per rejection, ≤ pressFreeRetries per press", async () => {
  const lim = { limit: 100, windowSec: 60, pressFreeRetries: 2 }, sender = `0x${"cd".repeat(20)}-${Date.now()}`, p = newPressId();
  assert.equal((await hitSenderSend(memoryCounter, sender, p, lim)).count, 1, "first send counts");
  assert.equal(await notePressRejected(memoryCounter, sender, p, lim), true);
  assert.equal((await hitSenderSend(memoryCounter, sender, p, lim)).count, 0, "retry after the rejection is free");
  assert.equal((await hitSenderSend(memoryCounter, sender, p, lim)).count, 2, "no second rejection ⇒ next send counts");
  assert.equal(await notePressRejected(memoryCounter, sender, p, lim), true);
  assert.equal((await hitSenderSend(memoryCounter, sender, p, lim)).count, 0);
  assert.equal(await notePressRejected(memoryCounter, sender, p, lim), false, "3rd grant > pressFreeRetries");
  assert.equal((await hitSenderSend(memoryCounter, sender, p, lim)).count, 3);
  // other sender, same id: nothing granted
  assert.equal((await hitSenderSend(memoryCounter, `${sender}-other`, p, lim)).count, 1);
  // malformed id never earns anything
  assert.equal(await notePressRejected(memoryCounter, sender, "nope", lim), false);
});

test("L1 notePressRejected: capped per sender per window across presses; store without get ⇒ counted", async () => {
  const lim = { limit: 100, windowSec: 60, pressFreeRetries: 2, grantsPerSender: 3 }, sender = `0x${"ef".repeat(20)}-${Date.now()}`;
  const g = [];
  for (let i = 0; i < 5; i++) g.push(await notePressRejected(memoryCounter, sender, newPressId(), lim));
  assert.deepEqual(g, [true, true, true, false, false]);
  const noGet = { incrEx: memoryCounter.incrEx, ttl: memoryCounter.ttl }, p = newPressId(), s2 = `${sender}-ng`;
  await notePressRejected(noGet, s2, p, lim);
  assert.equal((await hitSenderSend(noGet, s2, p, lim)).count, 1);
});

test("L1 rejectedBeforeSend: only pre-flight rejections with no tx signed", () => {
  const E = (m: string, x: object = {}) => Object.assign(new Error(m), x);
  assert.equal(rejectedBeforeSend(E("simulation failed: AA23 reverted")), true);
  assert.equal(rejectedBeforeSend(E("fee below relayer floor: maxFeePerGas 1 < 2", { code: "fee" })), true);
  assert.equal(rejectedBeforeSend(E("total gas 9 above cap 8", { code: "gas" })), true);
  assert.equal(rejectedBeforeSend(E("Execution reverted with reason: AA25 invalid account nonce")), true);
  assert.equal(rejectedBeforeSend(E("simulation failed: x", { txHash: "0x01" })), false, "signed ⇒ reached submission");
  assert.equal(rejectedBeforeSend(E("relayer tx 0xab reverted", { txHash: "0xab" })), false);
  assert.equal(rejectedBeforeSend(E("internal error", { code: -32603 })), false);
  assert.equal(rejectedBeforeSend(E("relayer not configured", { code: "relayer_not_configured" })), false);
  assert.equal(rejectedBeforeSend(E("network: fetch failed")), false);
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

// ---- AUDIT L2 (client): an unclear relay error ⇒ lookup by txHash / userOpHash, never a resend ----
import { relayErrorUnclear } from "../lib/aa/mav2";

test("relayErrorUnclear: txHash without notSent ⇒ unclear; notSent / sim failure / rate limit ⇒ not", () => {
  const h = "0x" + "55".repeat(32);
  assert.equal(relayErrorUnclear({ code: -32000, message: "disciple_sendUserOperationSync: internal error", data: { txHash: h } }), true);
  assert.equal(relayErrorUnclear({ code: -32000, message: "whatever new", data: { txHash: h, notSent: false } }), true);
  assert.equal(relayErrorUnclear({ code: -32000, message: "insufficient funds", data: { txHash: h, notSent: true } }), false);
  assert.equal(relayErrorUnclear({ code: -32000, message: "x: internal error" }), true);
  assert.equal(relayErrorUnclear({ code: -32098, message: "relay response unreadable (HTTP 504)" }), true);
  assert.equal(relayErrorUnclear({ code: -32099, message: "network: Failed to fetch" }), true);
  assert.equal(relayErrorUnclear({ code: -32000, message: "simulation failed: network glitch", data: "0x1234" }), false);
  assert.equal(relayErrorUnclear({ code: -32005, message: "rate limited, retry in 3s" }), false);
  assert.equal(relayErrorUnclear({ code: -32601, message: "not supported" }), false);
});

function stubRelayOnce(answer: object) {
  const orig = globalThis.fetch; let n = 0;
  globalThis.fetch = (async () => { n++; return Response.json({ jsonrpc: "2.0", id: 1, ...answer }); }) as typeof fetch;
  return { restore: () => { globalThis.fetch = orig; }, posts: () => n };
}
test("L2 client: -32603 with txHash after acceptance ⇒ receipt lookup by txHash; found ⇒ success, ONE POST", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  const { a, sent } = fakeAccount({ deployed: true });
  const tx = ("0x" + "66".repeat(32)) as Hex, looked: Hex[] = [];
  (a as unknown as { receiptFor: (t: Hex, h: Hex) => Promise<unknown> }).receiptFor = async (t, h) => { looked.push(t); return { userOpHash: h, txHash: t, success: true, logs: [] }; };
  const s = stubRelayOnce({ error: { code: -32000, message: "disciple_sendUserOperationSync: internal error", data: { txHash: tx, notSent: false } } });
  let r;
  try { r = await a.sendCalls(CALLS, { rebuild: async () => [approve, buy(1)] }); } finally { s.restore(); }
  assert.equal(r.txHash, tx); assert.deepEqual(looked, [tx]); assert.equal(s.posts(), 1); assert.equal(sent.length, 1, "built/signed once");
});
test("L2 client: unclear and NOT found (txHash or userOpHash) ⇒ Timeout 'still confirming', never resent / rebuilt", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  for (const error of [
    { code: -32000, message: "x: context canceled", data: { txHash: "0x" + "77".repeat(32) } },
    { code: -32099, message: "network: relay stream lost (aborted)" },
    { code: -32098, message: "relay response unreadable (HTTP 504)" },
    // an AA23-looking message WITH a txHash and no notSent: still a lookup, not the TRANSIENT_SIM resend
    { code: -32000, message: "relayer tx reverted: AA23", data: { txHash: "0x" + "78".repeat(32) } },
  ]) {
    const { a, sent } = fakeAccount({ deployed: true });
    let scans = 0, rebuilds = 0;
    (a as unknown as { receiptFor: () => Promise<null> }).receiptFor = async () => null;
    (a as unknown as { findOp: () => Promise<null> }).findOp = async () => { scans++; return null; };
    const s = stubRelayOnce({ error });
    try {
      await assert.rejects(a.sendCalls(CALLS, { rebuild: async () => { rebuilds++; return [approve, buy(1)]; } }), (e: { code?: string; message: string }) => e.code === "Timeout" && /still confirming/.test(e.message));
    } finally { s.restore(); }
    assert.equal(s.posts(), 1, error.message); assert.equal(sent.length, 1); assert.equal(rebuilds, 0); assert.equal(scans, 1);
  }
});
test("L2 client: notSent:true (definite) ⇒ no lookup, normal error (fee floor still re-signs once)", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  const { a, sent } = fakeAccount({ deployed: true });
  let looked = 0;
  (a as unknown as { receiptFor: () => Promise<null> }).receiptFor = async () => { looked++; return null; };
  const s = stubRelay({ code: -32000, message: "fee below relayer floor" });
  try { await a.sendCalls(CALLS, "owner"); } finally { s.restore(); }
  assert.equal(looked, 0); assert.equal(s.posts(), 2); assert.equal(sent.length, 2);
});

// ---- AUDIT Info: a rebuild never accepts a worse price than the press's original minOut ----
import { boundRebuiltMinOut } from "../lib/aa/fastPath";
test("boundRebuiltMinOut: fresh ≥ original ⇒ fresh; fresh < original ⇒ throws ⇒ retryCalls keeps the ORIGINAL calls", async () => {
  assert.equal(boundRebuiltMinOut(BigInt(100), BigInt(100)), BigInt(100));
  assert.equal(boundRebuiltMinOut(BigInt(100), BigInt(120)), BigInt(120));
  assert.throws(() => boundRebuiltMinOut(BigInt(100), BigInt(99)), /below the press's minOut/);
  const got = await retryCalls(CALLS, { rebuild: async () => [approve, buy(Number(boundRebuiltMinOut(BigInt(100), BigInt(90))))] });
  assert.equal(got, CALLS, "worse re-quote ⇒ original calls (original minOut 100 still enforced on-chain)");
});

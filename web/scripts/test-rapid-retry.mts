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
      await assert.rejects(a.sendCalls(CALLS, { rebuild: async () => { rebuilds++; return [approve, buy(1)]; } }), (e: { code?: string; message: string }) => e.code === "Timeout" && /still confirming/i.test(e.message));
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

// ---- GAME: the caller's reservation id (SendOpts.pressId) is echoed on every event / result / error of the press ----
function captureOps() {
  const evs: Record<string, unknown>[] = [], g = globalThis as unknown as { window?: unknown };
  const had = "window" in g, prev = g.window;
  g.window = { dispatchEvent: (e: CustomEvent) => { evs.push(e.detail as Record<string, unknown>); return true; } };
  return { evs, restore: () => { if (had) g.window = prev; else delete g.window; } };
}
test("GAME pressId: caller id reused across the TRANSIENT_SIM retry; on relay meta, every submitted/confirmed event and the result", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  const { a } = fakeAccount({ deployed: true });
  const cap = captureOps(), orig = globalThis.fetch, bodies: { params: unknown[] }[] = [];
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32500, message: "AA23 reverted" } }) : Response.json({ jsonrpc: "2.0", id: 1, result: CONF }); }) as unknown as typeof fetch;
  let r;
  try { r = await a.sendCalls(CALLS, { rebuild: async () => [approve, buy(9)], pressId: "game-res-1" }); } finally { globalThis.fetch = orig; cap.restore(); }
  assert.equal(r.pressId, "game-res-1");
  assert.deepEqual(bodies.map((b) => (b.params[2] as { pressId: string }).pressId), ["game-res-1", "game-res-1"]);
  // "sent" (SITE optimistic fill: the signed op left for the relay) fires per send attempt, with the press id
  assert.ok(cap.evs.filter((e) => e.phase === "sent").every((e) => e.pressId === cap.evs[0].pressId));
  assert.deepEqual(cap.evs.map((e) => e.phase).filter((p) => p !== "sent"), ["submitted", "confirmed"]);
  assert.ok(cap.evs.every((e) => e.pressId === "game-res-1"));
});
test("GAME pressId: failure after a retry ⇒ ONE terminal 'error' event + AAError.extra.pressId (standard path too)", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  {
    const { a } = fakeAccount({ deployed: true });
    (a as unknown as { receiptFor: () => Promise<null> }).receiptFor = async () => null;
    (a as unknown as { findOp: () => Promise<null> }).findOp = async () => null;
    const cap = captureOps(), s = stubRelayOnce({ error: { code: -32099, message: "network: relay stream lost" } });
    try {
      await assert.rejects(a.sendCalls(CALLS, { pressId: "res-2" }), (e: { code?: string; extra?: { pressId?: string } }) => e.code === "Timeout" && e.extra?.pressId === "res-2");
    } finally { s.restore(); cap.restore(); }
    assert.deepEqual(cap.evs.filter((e) => e.phase !== "sent").map((e) => [e.phase, e.pressId, e.code]), [["error", "res-2", "Timeout"]]);
  }
  {
    const { a } = fakeAccount({ deployed: false });   // standard path: 1st send TRANSIENT_SIM ⇒ retry, then a wait timeout
    const cl = await (a as unknown as { owned: () => Promise<{ waitForUserOperationTransaction: () => Promise<never> }> }).owned();
    cl.waitForUserOperationTransaction = async () => { throw new Error("timeout"); };
    const cap = captureOps();
    try { await assert.rejects(a.sendCalls(CALLS, "owner", true, { pressId: "res-3" }), (e: { extra?: { pressId?: string } }) => e.extra?.pressId === "res-3"); } finally { cap.restore(); }
    assert.deepEqual(cap.evs.map((e) => e.phase).filter((p) => p !== "sent"), ["submitted", "error"]); assert.ok(cap.evs.every((e) => e.pressId === "res-3"));
  }
});
test("GAME pressId: generated when absent (24 hex) and still echoed", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  const { a } = fakeAccount({ deployed: true }), cap = captureOps(), s = stubRelayOnce({ result: CONF });
  let r; try { r = await a.sendCalls(CALLS, "owner"); } finally { s.restore(); cap.restore(); }
  assert.match(r.pressId!, /^[0-9a-f]{24}$/); assert.ok(cap.evs.length >= 1 && cap.evs.every((e) => e.pressId === r.pressId));
});

// ---- #145 × #141 merge: one error-data shape carries notSent (L2) AND unclear / reason / relayNonce / userOpHash ----
import { relayErrorData } from "../lib/aa/relayTypes";
import { relayUnclear } from "../lib/aa/relayClient";
import { friendlyError } from "../lib/protocol-viem";

test("merge: relayErrorData keeps notSent beside relayNonce/userOpHash; unclear is never notSent", () => {
  const tx = ("0x" + "81".repeat(32)) as Hex, uoh = ("0x" + "82".repeat(32)) as Hex;
  // definite rejection after signing (fastRelay: notSent true) ⇒ txHash + relayNonce + notSent, no unclear
  assert.deepEqual(relayErrorData(Object.assign(new Error("insufficient funds"), { txHash: tx, userOpHash: uoh, relayNonce: 4, notSent: true })),
    { txHash: tx, userOpHash: uoh, relayNonce: 4, notSent: true });
  // unclear (receipt timeout) ⇒ unclear + reason, notSent forced false even if a caller set it
  assert.deepEqual(relayErrorData(Object.assign(new Error("not confirmed (timeout)"), { txHash: tx, relayNonce: 5, unclear: true, reason: "receipt-timeout", notSent: true }), uoh),
    { txHash: tx, userOpHash: uoh, relayNonce: 5, unclear: true, reason: "receipt-timeout", notSent: false });
  // client: a definite notSent never reads as unclear; relayErrorUnclear agrees
  const definite = { code: -32000, message: "x: network-ish failure", data: { txHash: tx, userOpHash: uoh, relayNonce: 4, notSent: true } };
  assert.equal(relayUnclear(definite, uoh), null); assert.equal(relayErrorUnclear(definite), false);
  const unclear = { code: -32000, message: "x: not confirmed", data: { txHash: tx, userOpHash: uoh, relayNonce: 5, unclear: true, reason: "receipt-timeout", notSent: false } };
  assert.deepEqual(relayUnclear(unclear, uoh), { unclear: true, reason: "receipt-timeout", userOpHash: uoh, txHash: tx, relayNonce: 5 });
  assert.equal(relayErrorUnclear(unclear), true);
});
test("merge: unclear relay error, not found ⇒ AAError Timeout extra = RelayTimeoutExtra + pressId; ProtocolError keeps it", async () => {
  await FEES.get(async () => ({ maxFeePerGas: BigInt(2), maxPriorityFeePerGas: BigInt(1) }));
  const { a } = fakeAccount({ deployed: true });
  (a as unknown as { receiptFor: () => Promise<null> }).receiptFor = async () => null;
  (a as unknown as { findOp: () => Promise<null> }).findOp = async () => null;
  const tx = ("0x" + "83".repeat(32)) as Hex;
  const s = stubRelayOnce({ error: { code: -32000, message: "x: internal error", data: { txHash: tx, relayNonce: 9, notSent: false } } });
  let err: { code?: string; extra?: Record<string, unknown> } | undefined;
  try { await a.sendCalls(CALLS, { pressId: "ab".repeat(12) }); } catch (e) { err = e as typeof err; } finally { s.restore(); }
  assert.equal(err?.code, "Timeout");
  const x = err!.extra!;
  assert.equal(x.unclear, true); assert.equal(x.txHash, tx); assert.equal(x.relayNonce, 9); assert.equal(x.sender, SENDER);
  assert.match(String(x.userOpHash), /^0x[0-9a-f]{64}$/); assert.equal(typeof x.nonce, "bigint"); assert.equal(x.pressId, "ab".repeat(12));
  const pe = friendlyError(err);
  assert.equal(pe.code, "Timeout"); assert.equal(pe.extra?.relayNonce, 9); assert.equal(pe.extra?.pressId, "ab".repeat(12));
});

// ---- AUDIT Low (sender lockout): the per-sender limit is charged only AFTER validation; pre-validation is IP+sender ----
import { sendLimiter, sendPerIpSender, SendLimitError, type CounterStore } from "../lib/server/limits";

function freshStore(): CounterStore {
  const m = new Map<string, number>();
  return { async incrEx(k) { const n = (m.get(k) ?? 0) + 1; m.set(k, n); return n; }, async ttl() { return 60; }, async get(k) { return m.has(k) ? String(m.get(k)) : null; } };
}
const SIM_FAIL = () => Object.assign(new Error("simulation failed: AA24 signature error"), { data: "0x08c379a0" });
/** The route's send flow (app/api/bundler/route.ts): pre() → validation (fastRelay / selfBundler) → beforeSend() → sign. */
async function routeSend(store: CounterStore, ip: string, sender: string, valid: boolean, pressId?: string): Promise<"sent" | "pre-429" | "post-429" | "rejected"> {
  const sl = sendLimiter(store, { ip, sender, pressId, env: {} });
  if (await sl.pre()) return "pre-429";
  try {
    if (!valid) throw SIM_FAIL();   // bad signature: the simulation rejects it before beforeSend
    await sl.beforeSend();
    return "sent";
  } catch (e) {
    await sl.rejected(e);
    if (e instanceof SendLimitError) return "post-429";
    return "rejected";
  }
}
const VICTIM = "0x00000000000000000000000000000000000000vv".replace(/v/g, "7");

test("sender lockout: an attacker IP spamming the victim's sender with bad signatures never touches the victim's limit", async () => {
  const st = freshStore();
  const out: string[] = [];
  for (let i = 0; i < 200; i++) out.push(await routeSend(st, "6.6.6.6", VICTIM, false, newPressId()));
  // cheap spam stays bounded per IP+sender (then per IP): nothing past the pre-validation cap reaches validation
  const cap = sendPerIpSender(bundlerSendPerSender({})).limit;
  assert.equal(out.filter((x) => x === "rejected").length, cap); assert.ok(out.slice(cap).every((x) => x === "pre-429"));
  assert.equal(await st.get!(`rl:bundler:send:sender:${VICTIM}`), null, "victim's per-sender bucket untouched");
  // the victim (another IP) still gets its FULL per-sender budget of valid sends
  const lim = bundlerSendPerSender({}).limit, v: string[] = [];
  for (let i = 0; i < lim; i++) v.push(await routeSend(st, "1.2.3.4", VICTIM, true, newPressId()));
  assert.ok(v.every((x) => x === "sent"), v.join(","));
});
test("sender lockout: the attacker can't burn the victim's free retries (grants consumed only after validation)", async () => {
  const st = freshStore(), press = newPressId();
  // attacker exhausts ITS OWN (ip, sender) grant budget with junk presses
  for (let i = 0; i < 30; i++) await routeSend(st, "6.6.6.6", VICTIM, false, newPressId());
  // victim's press: rejected pre-send (e.g. a lagging node) ⇒ ONE free retry still granted from the victim's IP
  assert.equal(await routeSend(st, "1.2.3.4", VICTIM, true, press), "sent");          // counts 1
  assert.equal(await routeSend(st, "1.2.3.4", VICTIM, false, press), "rejected");     // grant
  // the attacker learns the pressId and spams invalid ops with it: validation fails ⇒ the grant is NOT consumed
  for (let i = 0; i < 5; i++) assert.equal(await routeSend(st, "6.6.6.6", VICTIM, false, press), "rejected");
  // victim's retry (any IP) is free: the per-sender count stays at 1
  assert.equal(await routeSend(st, "5.5.5.5", VICTIM, true, press), "sent");
  assert.equal(await st.get!(`rl:bundler:send:sender:${VICTIM}`), "1");
  // a SendLimitError is never a pre-send rejection (no grant for hitting the limit)
  const sl = sendLimiter(st, { ip: "1.2.3.4", sender: VICTIM, pressId: press, env: {} });
  await sl.rejected(new SendLimitError(9));
  assert.equal(await st.get!(`rl:bundler:press:grants:1.2.3.4:${VICTIM}`), "1");
});
test("sender lockout: VALID ops are still limited per sender (across IPs), once per request", async () => {
  const st = freshStore(), lim = bundlerSendPerSender({ BUNDLER_SEND_PER_SENDER: "5" }).limit;
  assert.equal(lim, 5);
  const ips = ["1.1.1.1", "2.2.2.2", "3.3.3.3"], out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const sl = sendLimiter(st, { ip: ips[i % 3], sender: VICTIM, env: { BUNDLER_SEND_PER_SENDER: "5" } });
    assert.equal(await sl.pre(), null);
    try { await sl.beforeSend(); await sl.beforeSend(); out.push("sent"); } catch (e) { out.push(e instanceof SendLimitError ? "post-429" : "?"); }   // 2nd call (nonce re-sign) not double-charged
  }
  assert.deepEqual(out, ["sent", "sent", "sent", "sent", "sent", "post-429", "post-429"]);
  // read-only peek (Alchemy forward): full bucket ⇒ refused, and peeking never adds to it
  const sl = sendLimiter(st, { ip: "9.9.9.9", sender: VICTIM, env: { BUNDLER_SEND_PER_SENDER: "5" } });
  assert.equal((await sl.peek())?.ok, false); const before = await st.get!(`rl:bundler:send:sender:${VICTIM}`); await sl.peek();
  assert.equal(await st.get!(`rl:bundler:send:sender:${VICTIM}`), before);
});

// ---- AUDIT #145 Low A: a NODE -32005 after signing is never "nothing sent" ----
import { isSendLimitError } from "../lib/server/limits";
import { classifySendError } from "../lib/server/relayerNonce";

test("Low A: isSendLimitError matches only our own pre-send SendLimitError (no txHash)", () => {
  const h = "0x" + "77".repeat(32);
  assert.equal(isSendLimitError(new SendLimitError(3)), true);
  // node / sequencer -32005 (same wording as ours), with or without the signed txHash attached: not ours
  assert.equal(isSendLimitError(Object.assign(new Error("request rate limited"), { code: -32005 })), false);
  assert.equal(isSendLimitError(Object.assign(new Error("rate limited, retry in 3s"), { code: -32005 })), false);
  assert.equal(isSendLimitError(Object.assign(new Error("rate limited"), { code: -32005, txHash: h, relayNonce: 7 })), false);
  // a SendLimitError that somehow carries a txHash (signed) is not treated as nothing-sent either
  assert.equal(isSendLimitError(Object.assign(new SendLimitError(3), { txHash: h })), false);
  assert.equal(isSendLimitError({ code: -32005, message: "rate limited" }), false);
  assert.equal(isSendLimitError(null), false);
});

test("Low A: node -32005 after signing ⇒ route/stream data carries txHash without notSent ⇒ client treats it as UNCLEAR", () => {
  const h = "0x" + "78".repeat(32), uoh = "0x" + "79".repeat(32);
  const node = Object.assign(new Error("request rate limited"), { code: -32005 });
  assert.equal(classifySendError(node), "unclear");   // the nonce classifier already calls it unclear
  // what fastRelay throws once signed (txHash + relayNonce, notSent only for a definite rejection)
  const thrown = Object.assign(node, { txHash: h, userOpHash: uoh, relayNonce: 3, notSent: classifySendError(node) !== "unclear" });
  assert.equal(isSendLimitError(thrown), false);   // route.ts / relayStream.ts no longer short-circuit to -32005
  const data = relayErrorData(thrown, uoh)!;
  assert.equal(data.txHash, h);
  assert.notEqual(data.notSent, true);
  // the -32000 error the route/stream now returns is unclear to the client (lookup, never a resend) ...
  assert.equal(relayErrorUnclear({ code: -32000, message: "disciple_sendUserOperationSync: request rate limited", data }), true);
  // ... whereas our own limiter (-32005, nothing signed) stays a definite "rate limited"
  assert.equal(relayErrorUnclear({ code: -32005, message: "disciple_sendUserOperationSync: rate limited, retry in 3s" }), false);
});

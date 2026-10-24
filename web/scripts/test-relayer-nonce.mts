// lib/server/relayerNonce + the syncSend rules on BOTH relay paths (pure, no RPC).  pnpm test:relayer-nonce
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayerNonceCursor, classifySendError, sendWithCursor } from "../lib/server/relayerNonce";
import { plainSend, syncSend, type RpcFn } from "../lib/server/syncSend";
import { isNonceError, withRelayer } from "../lib/server/relayer";
import type { RelayReceipt } from "../lib/aa/relayTypes";
import type { Hex } from "viem";

const err = (code: number | undefined, message: string, extra: object = {}) => Object.assign(new Error(message), code === undefined ? {} : { code }, extra);
const pendingAt = (n: number) => { let reads = 0; const f = async () => { reads++; return n; }; return { f, reads: () => reads }; };
const RC: RelayReceipt = { transactionHash: `0x${"ab".repeat(32)}`, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x10", status: "0x1", gasUsed: "0x5208", logs: [] };
const fakeSign = (nonce: number) => `0x02${nonce.toString(16).padStart(4, "0")}` as Hex;
const hashOf = (raw: Hex) => `0x${raw.slice(2).padStart(64, "0")}` as Hex;
const noWait = { sleep: async () => undefined, pollMs: 0 };

test("cursor: one pending read, then consecutive nonces with no RPC (concurrent takers)", async () => {
  const p = pendingAt(7), c = new RelayerNonceCursor(p.f);
  const got = await Promise.all([c.take(), c.take(), c.take()]);
  assert.deepEqual(got.sort(), [7, 8, 9]); assert.equal(p.reads(), 1); assert.equal(c.peek, 10);
});

test("release: rolls back when no later nonce was handed out", async () => {
  const p = pendingAt(5), c = new RelayerNonceCursor(p.f);
  const n = await c.take();
  assert.equal(c.release(n), "rollback"); assert.equal(c.peek, 5);
  assert.equal(await c.take(), 5); assert.equal(p.reads(), 1, "no resync needed");
});

test("release: a later nonce is already out ⇒ resync from the pending count on the next take", async () => {
  let pending = 5; const c = new RelayerNonceCursor(async () => pending);
  const a = await c.take(), b = await c.take();
  assert.deepEqual([a, b], [5, 6]);
  assert.equal(c.release(a), "resync"); assert.equal(c.peek, undefined);
  pending = 5;   // 5 never landed: the pending count still says 5 ⇒ the gap is refilled
  assert.equal(await c.take(), 5);
});

test("classify: already known is NEVER a nonce error; too high / underpriced are; cause chains are walked", () => {
  assert.equal(classifySendError(err(-32000, "already known")), "unclear");
  assert.equal(classifySendError(err(-32000, "nonce too high: tx nonce 12, next 11")), "nonce");
  assert.equal(classifySendError(err(-32000, "nonce too low")), "nonce");
  assert.equal(classifySendError(err(-32000, "replacement transaction underpriced")), "nonce");
  assert.equal(classifySendError(err(-32000, "insufficient funds for gas * price + value")), "definitive");
  assert.equal(classifySendError(err(-32000, "max fee per gas less than block base fee")), "definitive");
  assert.equal(classifySendError(err(-32099, "network: fetch failed")), "unclear");
  assert.equal(classifySendError(err(4, "timeout")), "unclear");
  assert.equal(classifySendError(err(-32000, "relayer tx 0x.. not confirmed (timeout)", { unclear: true })), "unclear");
  // viem-style wrapper: no code on the outer error, the node's code/message on the cause
  const wrapped = Object.assign(new Error("Transaction creation failed."), { cause: err(-32000, "Nonce provided for the transaction is lower than the current nonce of the account.") });
  assert.equal(classifySendError(wrapped), "nonce");
  assert.equal(classifySendError(new Error("HTTP request failed.")), "unclear");
  assert.equal(classifySendError(err(undefined, "sign failed", { definitive: true })), "definitive");
});

test("sendWithCursor: definitive non-nonce rejection ⇒ nonce rolled back, the next send reuses it (no gap)", async () => {
  const c = new RelayerNonceCursor(async () => 20);
  await assert.rejects(sendWithCursor(c, async () => { throw err(-32000, "insufficient funds", { definitive: true }); }), /insufficient/);
  const seen: number[] = [];
  await sendWithCursor(c, async (n) => { seen.push(n); return "ok"; });
  assert.deepEqual(seen, [20]); assert.equal(c.stats.rollbacks, 1);
});

test("sendWithCursor: nonce too high (gap) ⇒ resync + re-sign with the pending nonce", async () => {
  let pending = 30; const c = new RelayerNonceCursor(async () => pending);
  await c.take(); await c.take();          // 30, 31 handed out; pretend 30 was lost without an error
  pending = 30;
  const seen: number[] = [];
  const r = await sendWithCursor(c, async (n) => { seen.push(n); if (n === 32) throw err(-32000, "nonce too high"); return n; });
  assert.deepEqual(seen, [32, 30]); assert.equal(r, 30);
});

test("sendWithCursor: already known / unclear ⇒ rethrown once, NEVER re-signed, cursor stays advanced", async () => {
  for (const e of [err(-32000, "already known"), err(-32099, "network: socket hang up"), err(-32000, "not confirmed (timeout)", { unclear: true })]) {
    const c = new RelayerNonceCursor(async () => 40);
    let sends = 0;
    await assert.rejects(sendWithCursor(c, async () => { sends++; throw e; }));
    assert.equal(sends, 1); assert.equal(c.peek, 41);
  }
});

test("sendWithCursor: nonce errors exhaust after 2 resyncs and leave the cursor to resync", async () => {
  const c = new RelayerNonceCursor(async () => 1);
  let sends = 0;
  await assert.rejects(sendWithCursor(c, async () => { sends++; throw err(-32000, "nonce too low"); }), /too low/);
  assert.equal(sends, 3); assert.equal(c.peek, undefined);
});

// ---- the two relay paths, composed exactly like lib/server/fastRelay (sign per nonce inside sendWithCursor) ----
function node(answers: ((m: string, p: unknown[]) => unknown)[]) {
  const calls: { m: string; p: unknown[] }[] = [];
  const rpc: RpcFn = async (m, p) => { calls.push({ m, p }); const f = answers.shift(); if (!f) throw new Error("unexpected call"); return f(m, p); };
  return { rpc, calls };
}

test("fast path: 'already known' on the sync send ⇒ ONE signature, waits on the same hash", async () => {
  const c = new RelayerNonceCursor(async () => 50), n = node([() => { throw err(-32000, "already known"); }]);
  const signed: number[] = [], waited: Hex[] = [];
  const r = await sendWithCursor(c, async (nonce) => {
    signed.push(nonce); const raw = fakeSign(nonce);
    return syncSend(raw, hashOf(raw), { send: { name: "sequencer", rpc: n.rpc }, getReceipt: async (h) => { waited.push(h); return RC; }, ...noWait });
  });
  assert.deepEqual(signed, [50]); assert.equal(r.pending, true); assert.deepEqual(waited, [hashOf(fakeSign(50))]); assert.equal(n.calls.length, 1);
});

test("fast path: definitive rejection (fee) ⇒ rolled back; nonce too low ⇒ resync + re-sign", async () => {
  let pending = 60; const c = new RelayerNonceCursor(async () => pending);
  const a = node([() => { throw err(-32000, "max fee per gas less than block base fee"); }]);
  await assert.rejects(sendWithCursor(c, async (nonce) => { const raw = fakeSign(nonce); return syncSend(raw, hashOf(raw), { send: { name: "sequencer", rpc: a.rpc }, getReceipt: async () => null }); }), /base fee/);
  assert.equal(c.peek, 60, "rolled back");
  pending = 61;   // another instance used 60
  const b = node([() => { throw err(-32000, "nonce too low: next nonce 61, tx nonce 60"); }, () => RC]);
  const signed: number[] = [];
  await sendWithCursor(c, async (nonce) => { signed.push(nonce); const raw = fakeSign(nonce); return syncSend(raw, hashOf(raw), { send: { name: "sequencer", rpc: b.rpc }, getReceipt: async () => null }); });
  assert.deepEqual(signed, [60, 61]);
});

test("standard path: plainSend 'already known' / network ⇒ hash returned, ONE signature (caller waits on it)", async () => {
  for (const e of [err(-32000, "already known"), err(-32099, "network: fetch failed"), err(4, "timeout")]) {
    const c = new RelayerNonceCursor(async () => 70), n = node([() => { throw e; }]);
    const signed: number[] = [];
    const r = await sendWithCursor(c, async (nonce) => { signed.push(nonce); const raw = fakeSign(nonce); return plainSend(raw, hashOf(raw), n.rpc); });
    assert.deepEqual(signed, [70]); assert.equal(r.txHash, hashOf(fakeSign(70))); assert.ok(r.pending);
    assert.deepEqual(n.calls.map((x) => x.m), ["eth_sendRawTransaction"]);
  }
});

test("standard path: accepted ⇒ pending null; definitive ⇒ rolled back; nonce too low ⇒ re-signed", async () => {
  let pending = 80; const c = new RelayerNonceCursor(async () => pending);
  const ok = await sendWithCursor(c, async (nonce) => { const raw = fakeSign(nonce); return plainSend(raw, hashOf(raw), node([() => "0x"]).rpc); });
  assert.equal(ok.pending, null); assert.equal(c.peek, 81);
  await assert.rejects(sendWithCursor(c, async (nonce) => { const raw = fakeSign(nonce); return plainSend(raw, hashOf(raw), node([() => { throw err(-32000, "intrinsic gas too low"); }]).rpc); }), (e: { definitive?: boolean }) => e.definitive === true);
  assert.equal(c.peek, 81, "rolled back");
  pending = 82; const signed: number[] = [];
  const n = node([() => { throw err(-32000, "nonce too low"); }, () => "0x"]);
  await sendWithCursor(c, async (nonce) => { signed.push(nonce); const raw = fakeSign(nonce); return plainSend(raw, hashOf(raw), n.rpc); });
  assert.deepEqual(signed, [81, 82]);
});

test("relayer.isNonceError / withRelayer: 'already known' is not retried (no re-sign); definite nonce errors are", async () => {
  assert.equal(isNonceError(new Error("already known")), false);
  assert.equal(isNonceError(new Error("nonce too high")), true);
  let tries = 0;
  await assert.rejects(withRelayer(async () => { tries++; throw new Error("already known"); }), /already known/);
  assert.equal(tries, 1);
});

// lib/server/syncSend: the relayer's eth_sendRawTransactionSync rules (pure, no RPC).  pnpm test:sync-send
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncSend, type RpcFn } from "../lib/server/syncSend";
import type { RelayReceipt } from "../lib/aa/relayTypes";

const RAW = "0x02f8aa" as const, HASH = `0x${"ab".repeat(32)}` as const;
const RC: RelayReceipt = { transactionHash: HASH, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x10", status: "0x1", gasUsed: "0x5208", logs: [{ address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", topics: [`0x${"11".repeat(32)}`], data: "0x" }] };
const err = (code: number | undefined, message: string) => Object.assign(new Error(message), code === undefined ? {} : { code });

function rec(answers: ((m: string, p: unknown[]) => unknown)[]) {
  const calls: { m: string; p: unknown[] }[] = [];
  const rpc: RpcFn = async (m, p) => { calls.push({ m, p }); const f = answers.shift(); if (!f) throw new Error("unexpected call"); return f(m, p); };
  return { rpc, calls };
}
const noWait = { sleep: async () => undefined, pollMs: 0 };

test("primary: [rawTx] ONLY (no timeout param), full receipt returned, no receipt reads", async () => {
  const s = rec([() => RC]); let reads = 0;
  const r = await syncSend(RAW, HASH, { send: { name: "sequencer", rpc: s.rpc }, getReceipt: async () => { reads++; return null; } });
  assert.deepEqual(s.calls, [{ m: "eth_sendRawTransactionSync", p: [RAW] }]);
  assert.equal(r.via, "sequencer-sync"); assert.equal(r.pending, false); assert.deepEqual(r.rc, RC); assert.equal(reads, 0);
});

test("sequencer unset ⇒ same [raw] call on the public RPC (today's behaviour)", async () => {
  const s = rec([() => RC]);
  const r = await syncSend(RAW, HASH, { send: { name: "rpc", rpc: s.rpc }, getReceipt: async () => null });
  assert.equal(r.via, "rpc-sync"); assert.deepEqual(s.calls[0].p, [RAW]);
});

for (const code of [-32602, -32601]) {
  test(`${code} (not accepted) ⇒ eth_sendRawTransaction with the SAME bytes, then the receipt is pushed (onPending first)`, async () => {
    const s = rec([() => { throw err(code, code === -32602 ? "cannot unmarshal non-string into Go value of type hexutil.Uint64" : "method not found"); }, () => HASH]);
    const pend: unknown[] = []; let n = 0;
    const r = await syncSend(RAW, HASH, { send: { name: "sequencer", rpc: s.rpc }, getReceipt: async () => (++n < 3 ? null : RC), onPending: (p) => pend.push(p), ...noWait });
    assert.deepEqual(s.calls.map((c) => [c.m, c.p]), [["eth_sendRawTransactionSync", [RAW]], ["eth_sendRawTransaction", [RAW]]]);
    assert.deepEqual(pend, [{ txHash: HASH, reason: "sync-unsupported" }]);
    assert.equal(r.via, "rpc-wait"); assert.equal(r.pending, true); assert.deepEqual(r.rc, RC);
  });
}

for (const [name, e, reason] of [
  ["EIP-7966 timeout (code 4)", err(4, "the transaction was added to the mempool but wasn't processed in time"), "sync-timeout"],
  ["network error", err(-32099, "network: fetch failed"), "sync-error"],
  ["unreadable response", err(-32098, "HTTP 502 unreadable"), "sync-error"],
  ["already known", err(-32000, "already known"), "sync-timeout"],
] as const) {
  test(`${name} ⇒ possibly accepted: NO resend, NO re-sign, wait for the precomputed hash`, async () => {
    const s = rec([() => { throw e; }]);
    const pend: unknown[] = [];
    const r = await syncSend(RAW, HASH, { send: { name: "sequencer", rpc: s.rpc }, getReceipt: async (h) => (h === HASH ? RC : null), onPending: (p) => pend.push(p), ...noWait });
    assert.equal(s.calls.length, 1, "exactly one send");
    assert.deepEqual(pend, [{ txHash: HASH, reason }]);
    assert.equal(r.pending, true);
  });
}

test("definitive rejection (nonce too low) ⇒ thrown with txHash, no wait (caller may resync + re-sign)", async () => {
  const s = rec([() => { throw err(-32000, "nonce too low: next nonce 12, tx nonce 11"); }]);
  let reads = 0;
  await assert.rejects(syncSend(RAW, HASH, { send: { name: "sequencer", rpc: s.rpc }, getReceipt: async () => { reads++; return null; } }), (e: { txHash?: string; message: string }) => e.txHash === HASH && /nonce too low/.test(e.message));
  assert.equal(reads, 0);
});

test("plain-send fallback rejected definitively ⇒ thrown; unclear ⇒ still waits", async () => {
  const a = rec([() => { throw err(-32601, "method not found"); }, () => { throw err(-32000, "insufficient funds for gas * price + value"); }]);
  await assert.rejects(syncSend(RAW, HASH, { send: { name: "sequencer", rpc: a.rpc }, getReceipt: async () => null }), /insufficient funds/);
  const b = rec([() => { throw err(-32602, "invalid argument"); }, () => { throw err(-32099, "network: socket hang up"); }]);
  const r = await syncSend(RAW, HASH, { send: { name: "sequencer", rpc: b.rpc }, getReceipt: async () => RC, ...noWait });
  assert.equal(r.pending, true);
});

test("slow path gives up after maxWaitMs with an 'unclear' error carrying txHash (never re-signed)", async () => {
  let t = 0;
  const s = rec([() => { throw err(4, "timeout"); }]);
  await assert.rejects(syncSend(RAW, HASH, { send: { name: "sequencer", rpc: s.rpc }, getReceipt: async () => null, now: () => (t += 1000), maxWaitMs: 5000, ...noWait }),
    (e: { txHash?: string; unclear?: boolean }) => e.txHash === HASH && e.unclear === true);
  assert.equal(s.calls.length, 1);
});

// ---- client: lib/aa/relayClient (NDJSON push, no polling) ----
import { relaySend } from "../lib/aa/relayClient";
const ndjson = (lines: unknown[], cut = false) => (async () => new Response(new ReadableStream({ pull(c) { const l = lines.shift(); if (l) c.enqueue(new TextEncoder().encode(JSON.stringify(l) + "\n")); else if (cut) c.error(new Error("reset")); else c.close(); } }), { headers: { "content-type": "application/x-ndjson" } })) as unknown as typeof fetch;
const CONF = { kind: "confirmed", userOpHash: HASH, txHash: HASH, success: true, receipt: RC, logs: RC.logs, via: "rpc-wait", t: { simulate: 1, signTx: 1, send: 1, mined: 1, total: 4 } };

test("client: pending frame pushed, then the confirmed frame with the full receipt", async () => {
  const seen: unknown[] = [];
  const a = await relaySend("http://x", {}, HASH, (p) => seen.push(p.txHash), ndjson([{ kind: "pending", pending: true, userOpHash: HASH, txHash: HASH, reason: "sync-timeout" }, CONF]));
  assert.deepEqual(seen, [HASH]); assert.deepEqual(a.result?.receipt.logs, RC.logs);
});
test("client: stream cut after pending ⇒ ambiguous network error that keeps the txHash", async () => {
  const a = await relaySend("http://x", {}, HASH, undefined, ndjson([{ kind: "pending", pending: true, userOpHash: HASH, txHash: HASH, reason: "sync-error" }], true));
  assert.match(a.error!.message, /^network:/); assert.equal((a.error!.data as { txHash: string }).txHash, HASH);
});
test("client: error frame / plain-JSON server passthrough", async () => {
  const e = await relaySend("http://x", {}, HASH, undefined, ndjson([{ kind: "error", code: -32500, message: "AA33 reverted", data: { revert: "0x08c379a0" } }]));
  assert.equal(e.error!.code, -32500); assert.equal(e.error!.data, "0x08c379a0");
  const p = await relaySend("http://x", {}, HASH, undefined, (async () => Response.json({ jsonrpc: "2.0", id: 1, result: CONF })) as unknown as typeof fetch);
  assert.equal(p.result?.txHash, HASH);
});
